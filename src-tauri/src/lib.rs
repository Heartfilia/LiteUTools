use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use clipboard_rs::{common::RustImage, Clipboard, ClipboardContext, RustImageData};
use image::GenericImageView;
use pdfium_render::prelude::*;
use printpdf::{
    ImageCompression, ImageOptimizationOptions, Mm, Op, PdfDocument, PdfPage, PdfSaveOptions,
    RawImage, XObjectTransform,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

struct SessionState {
    workspace_dir: Mutex<Option<PathBuf>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutputItem {
    id: String,
    label: String,
    detail: String,
    path: String,
    kind: String,
    preview_path: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskErrorItem {
    title: String,
    detail: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConversionProgress {
    current: usize,
    total: usize,
    label: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConversionResponse {
    mode: String,
    note: String,
    output_dir: Option<String>,
    output_file: Option<String>,
    outputs: Vec<OutputItem>,
    progress: ConversionProgress,
    errors: Vec<TaskErrorItem>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeDiagnostics {
    app_cache_dir: Option<String>,
    resource_dir: Option<String>,
    session_workspace_dir: Option<String>,
    pdfium_library_name: String,
    pdfium_candidates: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResolvedImport {
    path: String,
    kind: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConversionProgressEvent {
    run_id: String,
    progress: ConversionProgress,
    output: Option<OutputItem>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PdfImageParams {
    format: String,
    quality: String,
    naming_template: String,
    size_mode: String,
    size_value: u16,
    page_range: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImagePdfParams {
    page_size: String,
    orientation: String,
    fit_mode: String,
    margin_mm: f32,
    file_name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum ConversionParams {
    PdfImage(PdfImageParams),
    ImagePdf(ImagePdfParams),
}

#[tauri::command]
async fn run_conversion(
    app: AppHandle,
    state: State<'_, SessionState>,
    mode: String,
    paths: Vec<String>,
    params: Option<ConversionParams>,
    run_id: Option<String>,
) -> Result<ConversionResponse, String> {
    if paths.is_empty() {
        return Err("没有收到任何输入文件。".to_string());
    }

    let workspace_dir = ensure_session_workspace(&app, &state)?;
    let app_handle = app.clone();
    let event_run_id = run_id.unwrap_or_else(|| format!("run-{}", current_timestamp_millis()));

    tauri::async_runtime::spawn_blocking(move || match mode.as_str() {
        "pdf-to-images" => convert_pdf_to_images(
            &app_handle,
            &paths,
            &workspace_dir,
            &event_run_id,
            params
                .and_then(|value| match value {
                    ConversionParams::PdfImage(value) => Some(value),
                    _ => None,
                })
                .unwrap_or(PdfImageParams {
                    format: "png".to_string(),
                    quality: "standard".to_string(),
                    naming_template: "page-{page}".to_string(),
                    size_mode: "quality".to_string(),
                    size_value: 1280,
                    page_range: String::new(),
                }),
        ),
        "images-to-pdf" => convert_images_to_pdf(
            &app_handle,
            &paths,
            &workspace_dir,
            &event_run_id,
            params
                .and_then(|value| match value {
                    ConversionParams::ImagePdf(value) => Some(value),
                    _ => None,
                })
                .unwrap_or(ImagePdfParams {
                    page_size: "auto".to_string(),
                    orientation: "auto".to_string(),
                    fit_mode: "contain".to_string(),
                    margin_mm: 0.0,
                    file_name: "merged-images".to_string(),
                }),
        ),
        _ => Err("收到未知命令。".to_string()),
    })
    .await
    .map_err(|error| format!("后台转换任务执行失败: {error}"))?
}

#[tauri::command]
fn export_outputs(
    outputs: Vec<String>,
    destination_dir: String,
) -> Result<Vec<OutputItem>, String> {
    if outputs.is_empty() {
        return Err("没有可导出的结果。".to_string());
    }

    let destination = PathBuf::from(destination_dir);
    fs::create_dir_all(&destination).map_err(|error| format!("创建导出目录失败: {error}"))?;

    let mut exported = Vec::new();

    for (index, output) in outputs.iter().enumerate() {
        let source = PathBuf::from(output);
        if !source.exists() {
            continue;
        }

        let file_name = source
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "结果文件名无效。".to_string())?;
        let target = unique_target_path(&destination, file_name);
        fs::copy(&source, &target).map_err(|error| format!("导出文件失败: {error}"))?;

        exported.push(OutputItem {
            id: format!("exported-{index}"),
            label: target
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(file_name)
                .to_string(),
            detail: format!("已导出到 {}", destination.display()),
            path: target.to_string_lossy().to_string(),
            kind: file_kind_from_path(&target).to_string(),
            preview_path: None,
        });
    }

    Ok(exported)
}

#[tauri::command]
fn clear_session_outputs(state: State<SessionState>) -> Result<(), String> {
    let mut guard = state
        .workspace_dir
        .lock()
        .map_err(|_| "无法锁定会话工作区。".to_string())?;

    if let Some(dir) = guard.take() {
        let _ = fs::remove_dir_all(dir);
    }

    Ok(())
}

#[tauri::command]
fn open_output(path: String) -> Result<(), String> {
    let target = PathBuf::from(path);
    if !target.exists() {
        return Err("目标文件不存在。".to_string());
    }

    open_path_with_default_app(&target)
}

#[tauri::command]
fn reveal_output(path: String) -> Result<(), String> {
    let target = PathBuf::from(path);
    if !target.exists() {
        return Err("目标文件不存在。".to_string());
    }

    reveal_in_file_manager(&target)
}

#[tauri::command]
fn runtime_diagnostics(
    app: AppHandle,
    state: State<SessionState>,
) -> Result<RuntimeDiagnostics, String> {
    let app_cache_dir = app
        .path()
        .app_cache_dir()
        .ok()
        .map(|path| path.to_string_lossy().to_string());
    let resource_dir = app
        .path()
        .resource_dir()
        .ok()
        .map(|path| path.to_string_lossy().to_string());
    let session_workspace_dir = state
        .workspace_dir
        .lock()
        .map_err(|_| "无法读取会话工作区。".to_string())?
        .as_ref()
        .map(|path| path.to_string_lossy().to_string());
    let pdfium_candidates = pdfium_candidates(&app)
        .into_iter()
        .map(|path| {
            let exists = if path.exists() { "exists" } else { "missing" };
            format!("{exists}: {}", path.display())
        })
        .collect::<Vec<_>>();

    Ok(RuntimeDiagnostics {
        app_cache_dir,
        resource_dir,
        session_workspace_dir,
        pdfium_library_name: pdfium_library_file_name().to_string(),
        pdfium_candidates,
    })
}

#[tauri::command]
fn load_preview_data(path: String) -> Result<String, String> {
    let preview_path = PathBuf::from(path);
    let bytes = fs::read(&preview_path).map_err(|error| format!("读取预览文件失败: {error}"))?;
    let mime = match preview_path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_lowercase())
        .as_deref()
    {
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("bmp") => "image/bmp",
        _ => "image/png",
    };

    Ok(format!(
        "data:{mime};base64,{}",
        BASE64_STANDARD.encode(bytes)
    ))
}

#[tauri::command]
fn copy_image_to_clipboard(path: String) -> Result<(), String> {
    let image_data =
        RustImageData::from_path(&path).map_err(|error| format!("读取图片失败: {error}"))?;

    let clipboard = ClipboardContext::new().map_err(|error| format!("打开剪贴板失败: {error}"))?;
    clipboard
        .set_image(image_data)
        .map_err(|error| format!("写入图片剪贴板失败: {error}"))
}

#[tauri::command]
fn copy_files_to_clipboard(paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Err("没有可复制的文件。".to_string());
    }

    let file_paths = paths
        .into_iter()
        .map(PathBuf::from)
        .filter(|path| path.exists())
        .map(|path| path.to_string_lossy().to_string())
        .collect::<Vec<_>>();

    if file_paths.is_empty() {
        return Err("没有找到可复制的文件。".to_string());
    }

    let clipboard = ClipboardContext::new().map_err(|error| format!("打开剪贴板失败: {error}"))?;
    clipboard
        .set_files(file_paths)
        .map_err(|error| format!("写入文件剪贴板失败: {error}"))
}

#[tauri::command]
fn resolve_import_paths(paths: Vec<String>) -> Result<Vec<ResolvedImport>, String> {
    let mut resolved = Vec::new();

    for raw_path in paths {
        let path = PathBuf::from(raw_path);
        if path.is_dir() {
            let entries = fs::read_dir(&path)
                .map_err(|error| format!("读取文件夹 {} 失败: {error}", path.display()))?;

            let mut images = entries
                .filter_map(|entry| entry.ok().map(|value| value.path()))
                .filter(|entry_path| entry_path.is_file())
                .filter_map(|entry_path| {
                    let kind = file_kind_from_path(&entry_path);
                    if kind == "image" {
                        Some(ResolvedImport {
                            path: entry_path.to_string_lossy().to_string(),
                            kind: "image".to_string(),
                        })
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>();

            images.sort_by(|left, right| natural_sort_key(&left.path).cmp(&natural_sort_key(&right.path)));
            resolved.extend(images);
            continue;
        }

        let kind = file_kind_from_path(&path);
        if kind == "image" || kind == "pdf" {
            resolved.push(ResolvedImport {
                path: path.to_string_lossy().to_string(),
                kind: kind.to_string(),
            });
        }
    }

    Ok(resolved)
}

fn convert_pdf_to_images(
    app: &AppHandle,
    paths: &[String],
    workspace_dir: &Path,
    run_id: &str,
    params: PdfImageParams,
) -> Result<ConversionResponse, String> {
    let pdfium = bind_pdfium(app)?;
    let total = total_pdf_pages(&pdfium, paths, &params.page_range)?;
    emit_progress_event(
        app,
        run_id,
        ConversionProgress {
            current: 0,
            total,
            label: format!("已完成 0/{total}"),
        },
        None,
    );
    let mut outputs = Vec::new();
    let mut errors = Vec::new();
    let mut completed = 0usize;
    let output_root = workspace_dir.join("pdf-pages");
    fs::create_dir_all(&output_root).map_err(|error| format!("创建缓冲目录失败: {error}"))?;

    for raw_path in paths {
        let path = PathBuf::from(raw_path);
        let file_stem = path
            .file_stem()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "PDF 文件名无效。".to_string())?;
        let output_dir = output_root.join(format!("{file_stem}_pages"));
        fs::create_dir_all(&output_dir).map_err(|error| error.to_string())?;

        let document = match pdfium.load_pdf_from_file(&path, None) {
            Ok(document) => document,
            Err(error) => {
                errors.push(TaskErrorItem {
                    title: format!("打开 {} 失败", path.display()),
                    detail: error.to_string(),
                });
                continue;
            }
        };

        let render_config = pdf_render_config(&params)
            .render_form_data(true)
            .render_annotations(true);

        let selected_pages = resolve_selected_pages(document.pages().len() as usize, &params.page_range)?;

        for (index, page) in document.pages().iter().enumerate() {
            let page_number = index + 1;
            if !selected_pages.contains(&page_number) {
                continue;
            }

            let output_name = build_page_file_name(&params.naming_template, index + 1, &params.format);
            let output_path = output_dir.join(output_name);
            match page
                .render_with_config(&render_config)
                .and_then(|bitmap| bitmap.as_image())
            {
                Ok(image) => {
                    let preview_path = output_dir.join(format!("__preview_{:02}.png", index + 1));
                    let preview_result = save_preview_thumbnail(&image, &preview_path)
                        .map(|_| preview_path.to_string_lossy().to_string())
                        .ok();
                    let save_result = match params.format.as_str() {
                        "jpg" | "jpeg" => image
                            .into_rgb8()
                            .save_with_format(&output_path, image::ImageFormat::Jpeg),
                        _ => image.save_with_format(&output_path, image::ImageFormat::Png),
                    };
                    if let Err(error) = save_result {
                        errors.push(TaskErrorItem {
                            title: format!("保存 {} 第 {} 页失败", path.display(), index + 1),
                            detail: error.to_string(),
                        });
                    } else {
                        completed += 1;
                        outputs.push(OutputItem {
                            id: format!("pdf-page-{}-{}", file_stem, index + 1),
                            label: output_path
                                .file_name()
                                .and_then(|name| name.to_str())
                                .unwrap_or("page")
                                .to_string(),
                            detail: format!("来自 {} 第 {} 页", path.display(), index + 1),
                            path: output_path.to_string_lossy().to_string(),
                            kind: "image".to_string(),
                            preview_path: preview_result,
                        });
                        if let Some(output) = outputs.last().cloned() {
                            emit_progress_event(
                                app,
                                run_id,
                                ConversionProgress {
                                    current: completed,
                                    total,
                                    label: format!("已完成 {completed}/{total}"),
                                },
                                Some(output),
                            );
                        }
                    }
                }
                Err(error) => errors.push(TaskErrorItem {
                    title: format!("渲染 {} 第 {} 页失败", path.display(), index + 1),
                    detail: error.to_string(),
                }),
            }
        }
    }

    Ok(ConversionResponse {
        mode: "pdf-to-images".to_string(),
        note: if errors.is_empty() {
            format!("已在会话缓冲区生成 {} 张图片。", outputs.len())
        } else {
            format!("已生成 {} 张图片，另有 {} 个问题。", outputs.len(), errors.len())
        },
        output_dir: Some(output_root.to_string_lossy().to_string()),
        output_file: None,
        outputs,
        progress: ConversionProgress {
            current: completed,
            total,
            label: format!("已完成 {completed}/{total}"),
        },
        errors,
    })
}

fn convert_images_to_pdf(
    app: &AppHandle,
    paths: &[String],
    workspace_dir: &Path,
    run_id: &str,
    params: ImagePdfParams,
) -> Result<ConversionResponse, String> {
    const DEFAULT_IMAGE_PDF_DPI: f32 = 300.0;

    let output_root = workspace_dir.join("merged-pdf");
    fs::create_dir_all(&output_root).map_err(|error| format!("创建缓冲目录失败: {error}"))?;
    let output_path = unique_target_path(
        &output_root,
        &format!("{}.pdf", sanitize_file_stem(&params.file_name)),
    );

    let mut document = PdfDocument::new("LiteUtools Image Merge");
    let mut pages = Vec::new();
    let mut errors = Vec::new();
    let mut completed = 0usize;
    emit_progress_event(
        app,
        run_id,
        ConversionProgress {
            current: 0,
            total: paths.len(),
            label: format!("已完成 0/{}", paths.len()),
        },
        None,
    );

    for raw_path in paths {
        let path = PathBuf::from(raw_path);
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) => {
                errors.push(TaskErrorItem {
                    title: format!("读取 {} 失败", path.display()),
                    detail: error.to_string(),
                });
                continue;
            }
        };

        let mut warnings = Vec::new();
        let image = match RawImage::decode_from_bytes(&bytes, &mut warnings) {
            Ok(image) => image,
            Err(error) => {
                errors.push(TaskErrorItem {
                    title: format!("解析 {} 失败", path.display()),
                    detail: error,
                });
                continue;
            }
        };

        let dimensions = match image::open(&path) {
            Ok(image) => image.dimensions(),
            Err(error) => {
                errors.push(TaskErrorItem {
                    title: format!("读取 {} 尺寸失败", path.display()),
                    detail: error.to_string(),
                });
                continue;
            }
        };

        let (page_width_mm, page_height_mm) = resolve_page_size(
            dimensions.0,
            dimensions.1,
            &params.page_size,
            &params.orientation,
            DEFAULT_IMAGE_PDF_DPI,
        );
        let image_id = document.add_image(&image);
        completed += 1;
        emit_progress_event(
            app,
            run_id,
            ConversionProgress {
                current: completed,
                total: paths.len(),
                label: format!("已完成 {completed}/{}", paths.len()),
            },
            None,
        );
        let margin = params.margin_mm.max(0.0);
        let usable_width_mm = (page_width_mm - margin * 2.0).max(1.0);
        let usable_height_mm = (page_height_mm - margin * 2.0).max(1.0);
        let image_width_mm = px_to_mm_at_dpi(dimensions.0, DEFAULT_IMAGE_PDF_DPI);
        let image_height_mm = px_to_mm_at_dpi(dimensions.1, DEFAULT_IMAGE_PDF_DPI);
        let scale = fit_scale(
            image_width_mm,
            image_height_mm,
            usable_width_mm,
            usable_height_mm,
            &params.fit_mode,
        );
        let placed_width_mm = image_width_mm * scale;
        let placed_height_mm = image_height_mm * scale;
        let translate_x_mm = ((page_width_mm - placed_width_mm) / 2.0).max(0.0);
        let translate_y_mm = ((page_height_mm - placed_height_mm) / 2.0).max(0.0);

        pages.push(PdfPage::new(
            Mm(page_width_mm),
            Mm(page_height_mm),
            vec![Op::UseXobject {
                id: image_id,
                transform: XObjectTransform {
                    translate_x: Some(Mm(translate_x_mm).into_pt()),
                    translate_y: Some(Mm(translate_y_mm).into_pt()),
                    rotate: None,
                    scale_x: Some(scale),
                    scale_y: Some(scale),
                    dpi: Some(DEFAULT_IMAGE_PDF_DPI),
                },
            }],
        ));
    }

    if pages.is_empty() {
        return Err("没有成功处理任何图片，未生成 PDF。".to_string());
    }

    let mut save_options = PdfSaveOptions::default();
    save_options.image_optimization = Some(ImageOptimizationOptions {
        quality: None,
        max_image_size: None,
        dither_greyscale: Some(false),
        convert_to_greyscale: Some(false),
        auto_optimize: Some(false),
        format: Some(ImageCompression::Flate),
    });

    let bytes = document.with_pages(pages).save(&save_options, &mut Vec::new());
    fs::write(&output_path, bytes).map_err(|error| format!("写入 PDF 失败: {error}"))?;
    let preview_path = match render_pdf_first_page_preview(app, &output_path, &output_root) {
        Ok(path) => path,
        Err(error) => {
            errors.push(TaskErrorItem {
                title: "PDF 预览生成失败".to_string(),
                detail: error,
            });
            None
        }
    };

    Ok(ConversionResponse {
        mode: "images-to-pdf".to_string(),
        note: if errors.is_empty() {
            format!("已在会话缓冲区生成 PDF，共处理 {} 张图片。", completed)
        } else {
            format!("已生成 PDF，成功处理 {} 张图片，另有 {} 个问题。", completed, errors.len())
        },
        output_dir: Some(output_root.to_string_lossy().to_string()),
        output_file: Some(output_path.to_string_lossy().to_string()),
        outputs: vec![OutputItem {
            id: "merged-pdf".to_string(),
            label: output_path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("merged.pdf")
                .to_string(),
            detail: format!("会话缓冲区结果，来自 {} 张图片", completed),
            path: output_path.to_string_lossy().to_string(),
            kind: "pdf".to_string(),
            preview_path: preview_path.map(|path| path.to_string_lossy().to_string()),
        }],
        progress: ConversionProgress {
            current: completed,
            total: paths.len(),
            label: format!("已完成 {completed}/{}", paths.len()),
        },
        errors,
    })
}

fn emit_progress_event(
    app: &AppHandle,
    run_id: &str,
    progress: ConversionProgress,
    output: Option<OutputItem>,
) {
    let _ = app.emit(
        "conversion-progress",
        ConversionProgressEvent {
            run_id: run_id.to_string(),
            progress,
            output,
        },
    );
}

fn save_preview_thumbnail(image: &image::DynamicImage, preview_path: &Path) -> Result<(), String> {
    let thumbnail = image.thumbnail(320, 420);
    thumbnail
        .save_with_format(preview_path, image::ImageFormat::Png)
        .map_err(|error| format!("写入缩略图失败: {error}"))
}

fn total_pdf_pages(pdfium: &Pdfium, paths: &[String], page_range: &str) -> Result<usize, String> {
    let mut total = 0usize;

    for raw_path in paths {
        let path = PathBuf::from(raw_path);
        let document = pdfium
            .load_pdf_from_file(&path, None)
            .map_err(|error| format!("预读取 {} 失败: {error}", path.display()))?;
        let page_count =
            usize::try_from(document.pages().len()).map_err(|_| format!("读取 {} 页数失败。", path.display()))?;
        total += resolve_selected_pages(page_count, page_range)?.len();
    }

    Ok(total)
}

fn resolve_selected_pages(total_pages: usize, page_range: &str) -> Result<Vec<usize>, String> {
    if page_range.trim().is_empty() {
        return Ok((1..=total_pages).collect());
    }

    let mut pages = Vec::new();

    for part in page_range.split(',').map(str::trim).filter(|part| !part.is_empty()) {
        if let Some((start, end)) = part.split_once('-') {
            let start = start
                .trim()
                .parse::<usize>()
                .map_err(|_| format!("页码范围无效: {part}"))?;
            let end = end
                .trim()
                .parse::<usize>()
                .map_err(|_| format!("页码范围无效: {part}"))?;

            if start == 0 || end == 0 || start > end {
                return Err(format!("页码范围无效: {part}"));
            }

            for page in start..=end {
                if page <= total_pages && !pages.contains(&page) {
                    pages.push(page);
                }
            }
        } else {
            let page = part
                .parse::<usize>()
                .map_err(|_| format!("页码无效: {part}"))?;

            if page == 0 {
                return Err(format!("页码无效: {part}"));
            }

            if page <= total_pages && !pages.contains(&page) {
                pages.push(page);
            }
        }
    }

    if pages.is_empty() {
        return Err("页码范围没有命中任何有效页面。".to_string());
    }

    pages.sort_unstable();
    Ok(pages)
}

fn ensure_session_workspace(app: &AppHandle, state: &State<SessionState>) -> Result<PathBuf, String> {
    let mut guard = state
        .workspace_dir
        .lock()
        .map_err(|_| "无法锁定会话工作区。".to_string())?;

    if let Some(dir) = guard.as_ref() {
        if dir.exists() {
            return Ok(dir.clone());
        }
    }

    let base = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("读取缓存目录失败: {error}"))?;
    fs::create_dir_all(&base).map_err(|error| format!("创建缓存目录失败: {error}"))?;
    let timestamp = current_timestamp_millis();
    let workspace = base.join(format!("session-{timestamp}"));
    fs::create_dir_all(&workspace).map_err(|error| format!("创建会话目录失败: {error}"))?;
    *guard = Some(workspace.clone());
    Ok(workspace)
}

fn current_timestamp_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn cleanup_stale_session_workspaces(app: &AppHandle) -> Result<(), String> {
    let base = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("读取缓存目录失败: {error}"))?;

    if !base.exists() {
        return Ok(());
    }

    let entries = fs::read_dir(&base).map_err(|error| format!("读取缓存目录失败: {error}"))?;

    for entry in entries {
        let entry = entry.map_err(|error| format!("读取缓存条目失败: {error}"))?;
        let path = entry.path();

        if !path.is_dir() {
            continue;
        }

        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };

        if !name.starts_with("session-") {
            continue;
        }

        let _ = fs::remove_dir_all(&path);
    }

    Ok(())
}

fn unique_target_path(directory: &Path, file_name: &str) -> PathBuf {
    let candidate = directory.join(file_name);
    if !candidate.exists() {
        return candidate;
    }

    let stem = Path::new(file_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("output");
    let extension = Path::new(file_name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");

    for index in 2..1000 {
        let name = if extension.is_empty() {
            format!("{stem}-{index}")
        } else {
            format!("{stem}-{index}.{extension}")
        };

        let next = directory.join(name);
        if !next.exists() {
            return next;
        }
    }

    directory.join(file_name)
}

fn px_to_mm_at_dpi(px: u32, dpi: f32) -> f32 {
    px as f32 * 25.4 / dpi.max(1.0)
}

fn pdf_render_config(params: &PdfImageParams) -> PdfRenderConfig {
    let quality_width = match params.quality.as_str() {
        "standard" => 1280,
        "print" => 3200,
        _ => 2200,
    };

    let custom_size = usize::from(params.size_value.clamp(400, 6000));
    match params.size_mode.as_str() {
        "long-edge" => PdfRenderConfig::new()
            .set_maximum_width(custom_size as i32)
            .set_maximum_height(custom_size as i32),
        "width" => PdfRenderConfig::new().set_target_width(custom_size as i32),
        _ => PdfRenderConfig::new()
            .set_target_width(quality_width)
            .set_maximum_height(quality_width),
    }
}

fn build_page_file_name(template: &str, page: usize, format: &str) -> String {
    let base = if template.trim().is_empty() {
        "page-{page}".to_string()
    } else {
        template.to_string()
    };
    let name = base.replace("{page}", &format!("{page:02}"));
    format!("{}.{}", sanitize_file_stem(&name), if format == "jpg" { "jpg" } else { "png" })
}

fn sanitize_file_stem(value: &str) -> String {
    let cleaned = value
        .chars()
        .map(|char| match char {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            _ => char,
        })
        .collect::<String>();
    let trimmed = cleaned.trim().trim_matches('.').to_string();
    if trimmed.is_empty() {
        "output".to_string()
    } else {
        trimmed
    }
}

fn natural_sort_key(path: &str) -> Vec<String> {
    let file_name = Path::new(path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(path)
        .to_lowercase();

    let mut tokens = Vec::new();
    let mut buffer = String::new();
    let mut current_is_digit = None;

    for ch in file_name.chars() {
        let is_digit = ch.is_ascii_digit();
        if current_is_digit == Some(is_digit) || current_is_digit.is_none() {
            buffer.push(ch);
            current_is_digit = Some(is_digit);
        } else {
            if current_is_digit == Some(true) {
                tokens.push(format!("{:0>12}", buffer));
            } else {
                tokens.push(buffer.clone());
            }
            buffer.clear();
            buffer.push(ch);
            current_is_digit = Some(is_digit);
        }
    }

    if !buffer.is_empty() {
        if current_is_digit == Some(true) {
            tokens.push(format!("{:0>12}", buffer));
        } else {
            tokens.push(buffer);
        }
    }

    tokens
}

fn resolve_page_size(
    image_width_px: u32,
    image_height_px: u32,
    page_size: &str,
    orientation: &str,
    auto_dpi: f32,
) -> (f32, f32) {
    let (mut width, mut height) = match page_size {
        "a4" => (210.0, 297.0),
        "letter" => (215.9, 279.4),
        _ => (
            px_to_mm_at_dpi(image_width_px, auto_dpi),
            px_to_mm_at_dpi(image_height_px, auto_dpi),
        ),
    };

    let image_is_landscape = image_width_px > image_height_px;
    match orientation {
        "landscape" => {
            if width < height {
                std::mem::swap(&mut width, &mut height);
            }
        }
        "portrait" => {
            if width > height {
                std::mem::swap(&mut width, &mut height);
            }
        }
        _ => {
            if page_size != "auto" && image_is_landscape && width < height {
                std::mem::swap(&mut width, &mut height);
            }
        }
    }

    (width, height)
}

fn fit_scale(
    source_width_mm: f32,
    source_height_mm: f32,
    max_width_mm: f32,
    max_height_mm: f32,
    fit_mode: &str,
) -> f32 {
    let width_ratio = max_width_mm / source_width_mm.max(1.0);
    let height_ratio = max_height_mm / source_height_mm.max(1.0);
    match fit_mode {
        "cover" => width_ratio.max(height_ratio),
        _ => width_ratio.min(height_ratio),
    }
}

fn render_pdf_first_page_preview(
    app: &AppHandle,
    pdf_path: &Path,
    output_root: &Path,
) -> Result<Option<PathBuf>, String> {
    let pdfium = match try_bind_pdfium(app) {
        Ok(pdfium) => pdfium,
        Err(_) => return Ok(None),
    };

    let document = match pdfium.load_pdf_from_file(pdf_path, None) {
        Ok(document) => document,
        Err(_) => return Ok(None),
    };
    let first_page = match document.pages().get(0) {
        Ok(page) => page,
        Err(_) => return Ok(None),
    };

    let preview_path = output_root.join("merged-preview.png");
    first_page
        .render_with_config(
            &PdfRenderConfig::new()
                .set_target_width(1200)
                .set_maximum_height(1600)
                .render_form_data(true)
                .render_annotations(true),
        )
        .and_then(|bitmap| bitmap.as_image())
        .map_err(|error| error.to_string())?
        .save_with_format(&preview_path, image::ImageFormat::Png)
        .map_err(|error| error.to_string())?;

    Ok(Some(preview_path))
}
fn file_kind_from_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_lowercase())
        .as_deref()
    {
        Some("png" | "jpg" | "jpeg" | "webp" | "bmp" | "gif" | "tiff") => "image",
        Some("pdf") => "pdf",
        _ => "file",
    }
}

fn open_path_with_default_app(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(path)
            .status()
            .map_err(|error| format!("打开文件失败: {error}"))?;
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/C", "start", ""])
            .arg(path)
            .status()
            .map_err(|error| format!("打开文件失败: {error}"))?;
        return Ok(());
    }

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        Command::new("xdg-open")
            .arg(path)
            .status()
            .map_err(|error| format!("打开文件失败: {error}"))?;
        Ok(())
    }
}

fn reveal_in_file_manager(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .args(["-R"])
            .arg(path)
            .status()
            .map_err(|error| format!("打开所在目录失败: {error}"))?;
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg("/select,")
            .arg(path)
            .status()
            .map_err(|error| format!("打开所在目录失败: {error}"))?;
        return Ok(());
    }

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        let directory = path
            .parent()
            .ok_or_else(|| "无法定位所在目录。".to_string())?;
        Command::new("xdg-open")
            .arg(directory)
            .status()
            .map_err(|error| format!("打开所在目录失败: {error}"))?;
        Ok(())
    }
}

fn bind_pdfium(app: &AppHandle) -> Result<Pdfium, String> {
    try_bind_pdfium(app).map_err(|error| {
        format!(
            "{error}。请确认 Pdfium 已被打进应用资源目录，或先执行 `npm run pdfium:setup` 后再重新启动。"
        )
    })
}

fn try_bind_pdfium(app: &AppHandle) -> Result<Pdfium, String> {
    let candidates = pdfium_candidates(app);

    for candidate in &candidates {
        if candidate.exists() {
            match Pdfium::bind_to_library(candidate) {
                Ok(bindings) => return Ok(Pdfium::new(bindings)),
                Err(PdfiumError::PdfiumLibraryBindingsAlreadyInitialized) => {
                    return Ok(Pdfium::default())
                }
                Err(error) => {
                    return Err(format!(
                        "加载 Pdfium 动态库失败（{}）: {error}",
                        candidate.display()
                    ))
                }
            }
        }
    }

    match Pdfium::bind_to_system_library() {
        Ok(bindings) => Ok(Pdfium::new(bindings)),
        Err(PdfiumError::PdfiumLibraryBindingsAlreadyInitialized) => Ok(Pdfium::default()),
        Err(system_error) => Err({
            let tried = candidates
                .iter()
                .map(|path| path.display().to_string())
                .collect::<Vec<_>>()
                .join("；");
            format!(
                "没有找到可用的 Pdfium 动态库。系统库加载错误: {system_error}。已尝试这些路径: {tried}"
            )
        }),
    }
}

fn pdfium_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("pdfium/macos/libpdfium.dylib"));
        candidates.push(resource_dir.join("pdfium/windows/pdfium.dll"));
        candidates.push(resource_dir.join("pdfium/linux/libpdfium.so"));
        candidates.push(resource_dir.join(pdfium_library_file_name()));
    }

    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            candidates.push(exe_dir.join(pdfium_library_file_name()));
            candidates.push(exe_dir.join("../Resources/pdfium/macos/libpdfium.dylib"));
            candidates.push(exe_dir.join("../Resources/pdfium/windows/pdfium.dll"));
            candidates.push(exe_dir.join("../Resources/pdfium/linux/libpdfium.so"));
            candidates.push(exe_dir.join("../../resources/pdfium/macos/libpdfium.dylib"));
            candidates.push(exe_dir.join("../../resources/pdfium/windows/pdfium.dll"));
            candidates.push(exe_dir.join("../../resources/pdfium/linux/libpdfium.so"));
        }
    }

    if let Ok(current_dir) = std::env::current_dir() {
        candidates.push(current_dir.join(pdfium_library_file_name()));
        candidates.push(current_dir.join("resources/pdfium/macos/libpdfium.dylib"));
        candidates.push(current_dir.join("resources/pdfium/windows/pdfium.dll"));
        candidates.push(current_dir.join("resources/pdfium/linux/libpdfium.so"));
        candidates.push(current_dir.join("../resources/pdfium/macos/libpdfium.dylib"));
        candidates.push(current_dir.join("../resources/pdfium/windows/pdfium.dll"));
        candidates.push(current_dir.join("../resources/pdfium/linux/libpdfium.so"));
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    candidates.push(manifest_dir.join("../resources/pdfium/macos/libpdfium.dylib"));
    candidates.push(manifest_dir.join("../resources/pdfium/windows/pdfium.dll"));
    candidates.push(manifest_dir.join("../resources/pdfium/linux/libpdfium.so"));
    candidates.push(manifest_dir.join(pdfium_library_file_name()));
    candidates.push(PathBuf::from(pdfium_library_file_name()));

    let mut deduped = Vec::new();
    for candidate in candidates {
        let normalized = candidate
            .canonicalize()
            .unwrap_or_else(|_| candidate.clone());
        if !deduped.contains(&normalized) {
            deduped.push(normalized);
        }
    }

    deduped
}

fn pdfium_library_file_name() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "pdfium.dll"
    }

    #[cfg(target_os = "macos")]
    {
        "libpdfium.dylib"
    }

    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        "libpdfium.so"
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SessionState {
            workspace_dir: Mutex::new(None),
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            cleanup_stale_session_workspaces(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            run_conversion,
            export_outputs,
            clear_session_outputs,
            copy_files_to_clipboard,
            copy_image_to_clipboard,
            open_output,
            reveal_output,
            runtime_diagnostics,
            load_preview_data,
            resolve_import_paths
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
