import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type PointerEvent,
} from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { AnimatePresence, animate, motion } from 'framer-motion'
import './App.css'

type ToolId = 'convert' | 'blank'
type SourceKind = 'pdf' | 'image'

type ToolDefinition = {
  id: ToolId
  title: string
  subtitle: string
  icon: string
  color: string
}

type SourceItem = {
  id: string
  name: string
  path: string
  kind: SourceKind
  detail: string
}

type OutputItem = {
  id: string
  label: string
  detail: string
  path: string
  kind: 'image' | 'pdf' | 'file'
  previewPath?: string
}

type TaskErrorItem = {
  title: string
  detail: string
}

type ConversionProgress = {
  current: number
  total: number
  label: string
}

type PdfImageFormat = 'png' | 'jpg'
type PdfImageQuality = 'standard' | 'hd' | 'print'
type PdfImageParams = {
  format: PdfImageFormat
  quality: PdfImageQuality
  namingTemplate: string
  sizeMode: 'quality' | 'long-edge' | 'width'
  sizeValue: number
  pageRange: string
}

type PdfPageSize = 'auto' | 'a4' | 'letter'
type PdfOrientation = 'auto' | 'portrait' | 'landscape'
type ImagePdfParams = {
  pageSize: PdfPageSize
  orientation: PdfOrientation
  fitMode: 'contain' | 'cover'
  marginMm: number
  fileName: string
}

type ConversionSummary = {
  mode: 'pdf-to-images' | 'images-to-pdf'
  note: string
  outputDir?: string
  outputFile?: string
  outputs: OutputItem[]
  progress: ConversionProgress
  errors: TaskErrorItem[]
}

type Corner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'

type RuntimeDiagnostics = {
  appCacheDir?: string
  resourceDir?: string
  sessionWorkspaceDir?: string
  pdfiumLibraryName: string
  pdfiumCandidates: string[]
}

type ConversionProgressEvent = {
  runId: string
  progress: ConversionProgress
  output?: OutputItem
}

type OutputViewMode = 'grid' | 'list'

type ResolvedImport = {
  path: string
  kind: 'pdf' | 'image' | 'file'
}

const tools: ToolDefinition[] = [
  {
    id: 'convert',
    title: 'PDF / 图片转换',
    subtitle: '导入 PDF 拆分为图片，导入图片合并成 PDF。',
    icon: 'PDF',
    color: 'linear-gradient(135deg, #ff7b54 0%, #ffb26b 100%)',
  },
  {
    id: 'blank',
    title: '空白工具位',
    subtitle: '用于测试圆盘切换、标题联动和后续扩展新工具。',
    icon: 'LAB',
    color: 'linear-gradient(135deg, #5d8cff 0%, #8ec5ff 100%)',
  },
]

const launcherGap = 16
const launcherSize = 66
const margin = 28
const imageExtensions = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tiff']

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) {
    return error.message
  }

  if (typeof error === 'string' && error.trim()) {
    return error
  }

  if (error && typeof error === 'object') {
    const maybeMessage = Reflect.get(error, 'message')
    if (typeof maybeMessage === 'string' && maybeMessage.trim()) {
      return maybeMessage
    }

    try {
      const serialized = JSON.stringify(error)
      if (serialized && serialized !== '{}') {
        return serialized
      }
    } catch {
      return fallback
    }
  }

  return fallback
}

async function invokeBackend<T>(command: string, payload?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, payload)
  } catch (error) {
    const message = getErrorMessage(error, '调用本地命令失败')

    if (
      /ipc|invoke|tauri|window.__TAURI_IPC__|not available/i.test(message)
    ) {
      if (error instanceof Error) {
        throw new Error('当前启动的不是 Tauri 桌面程序，请使用 `npm run tauri:dev` 或打包后的 `.app` 启动。', {
          cause: error,
        })
      }

      throw new Error('当前启动的不是 Tauri 桌面程序，请使用 `npm run tauri:dev` 或打包后的 `.app` 启动。', {
        cause: error,
      })
    }

    if (error instanceof Error) {
      throw new Error(message, { cause: error })
    }

    throw new Error(message, { cause: error })
  }
}

function getExtension(path: string) {
  return path.split('.').pop()?.toLowerCase() ?? ''
}

function getFilePath(file: File) {
  return (file as File & { path?: string }).path ?? ''
}

function getFileName(path: string) {
  return path.split(/[\\/]/).pop() ?? path
}

function classifyPath(path: string): SourceKind | null {
  const ext = getExtension(path)
  if (ext === 'pdf') {
    return 'pdf'
  }
  if (imageExtensions.includes(ext)) {
    return 'image'
  }
  return null
}

function describeSource(path: string, index: number) {
  const kind = classifyPath(path)
  if (!kind) {
    return null
  }

  return {
    id: `${path}-${index}-${Date.now()}`,
    name: getFileName(path),
    path,
    kind,
    detail: kind === 'pdf' ? 'PDF 文档 · 待拆分' : `图片素材 · 顺序 ${index + 1}`,
  } satisfies SourceItem
}

function reorder<T>(list: T[], from: number, to: number) {
  const next = [...list]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

function sanitizePreviewName(value: string) {
  const cleaned = value
    .split('')
    .map((char) => (/[\\/:*?"<>|]/.test(char) ? '-' : char))
    .join('')
    .trim()
    .replace(/^\.+|\.+$/g, '')

  return cleaned.length > 0 ? cleaned : 'output'
}

function buildPagePreviewName(template: string, page: number, format: PdfImageFormat) {
  const base = (template.trim() || 'page-{page}').replace('{page}', String(page).padStart(2, '0'))
  const fileName = sanitizePreviewName(base)
  return `${fileName}.${format === 'jpg' ? 'jpg' : 'png'}`
}

function getCornerFromAnchor(anchor: { x: number; y: number }) {
  const horizontal = anchor.x + launcherSize / 2 <= window.innerWidth / 2 ? 'left' : 'right'
  const vertical = anchor.y + launcherSize / 2 <= window.innerHeight / 2 ? 'top' : 'bottom'
  return `${vertical}-${horizontal}` as Corner
}

function App() {
  const [activeTool, setActiveTool] = useState<ToolId>('convert')
  const [menuOpen, setMenuOpen] = useState(false)
  const [hoveredTool, setHoveredTool] = useState<ToolId | null>(null)
  const [sources, setSources] = useState<SourceItem[]>([])
  const [outputs, setOutputs] = useState<OutputItem[]>([])
  const [errors, setErrors] = useState<TaskErrorItem[]>([])
  const [statusText, setStatusText] = useState('等待导入文件')
  const [isBusy, setIsBusy] = useState(false)
  const [progress, setProgress] = useState<ConversionProgress>({
    current: 0,
    total: 0,
    label: '尚未开始',
  })
  const [draggingSourceId, setDraggingSourceId] = useState<string | null>(null)
  const [sessionBufferPath, setSessionBufferPath] = useState('')
  const [pdfParamsEnabled, setPdfParamsEnabled] = useState(false)
  const [imageParamsEnabled, setImageParamsEnabled] = useState(false)
  const [pdfImageParams, setPdfImageParams] = useState<PdfImageParams>({
    format: 'png',
    quality: 'standard',
    namingTemplate: 'page-{page}',
    sizeMode: 'quality',
    sizeValue: 1280,
    pageRange: '',
  })
  const [imagePdfParams, setImagePdfParams] = useState<ImagePdfParams>({
    pageSize: 'auto',
    orientation: 'auto',
    fitMode: 'contain',
    marginMm: 0,
    fileName: 'merged-images',
  })
  const [previewSrcMap, setPreviewSrcMap] = useState<Record<string, string>>({})
  const [outputViewMode, setOutputViewMode] = useState<OutputViewMode>('grid')
  const [previewingOutput, setPreviewingOutput] = useState<OutputItem | null>(null)
  const [previewScale, setPreviewScale] = useState(1)
  const [previewOffset, setPreviewOffset] = useState({ x: 0, y: 0 })
  const [anchor, setAnchor] = useState({ x: margin, y: 0 })
  const launcherLayerRef = useRef<HTMLDivElement | null>(null)
  const activeRunIdRef = useRef<string | null>(null)
  const lightboxStageRef = useRef<HTMLDivElement | null>(null)
  const lightboxImageRef = useRef<HTMLImageElement | null>(null)
  const previewDragRef = useRef({
    dragging: false,
    startX: 0,
    startY: 0,
    originX: 0,
    originY: 0,
  })
  const dragRef = useRef({
    active: false,
    moved: false,
    pointerOffsetX: 0,
    pointerOffsetY: 0,
    width: 0,
    height: 0,
  })

  const currentTool = useMemo(
    () => tools.find((tool) => tool.id === activeTool) ?? tools[0],
    [activeTool],
  )
  const inactiveTools = useMemo(
    () => tools.filter((tool) => tool.id !== activeTool),
    [activeTool],
  )
  const currentCorner = useMemo(() => getCornerFromAnchor(anchor), [anchor])
  const titleSide = currentCorner.includes('left') ? 'right' : 'left'
  const stackDirection = currentCorner.includes('bottom') ? 'up' : 'down'

  const hasPdfSources = useMemo(() => sources.some((item) => item.kind === 'pdf'), [sources])
  const hasImageSources = useMemo(() => sources.some((item) => item.kind === 'image'), [sources])
  const showPdfPanel = hasPdfSources && !hasImageSources
  const showImagePanel = hasImageSources && !hasPdfSources
  const progressPercent =
    progress.total > 0 ? Math.min(100, Math.round((progress.current / progress.total) * 100)) : 0
  const pageNamePreview = useMemo(
    () => buildPagePreviewName(pdfImageParams.namingTemplate, 1, pdfImageParams.format),
    [pdfImageParams.format, pdfImageParams.namingTemplate],
  )
  const pdfNamePreview = useMemo(
    () => `${sanitizePreviewName(imagePdfParams.fileName)}.pdf`,
    [imagePdfParams.fileName],
  )

  const outputCards = useMemo(
    () =>
      outputs.map((item) => ({
        ...item,
        previewSrc: previewSrcMap[item.id],
      })),
    [outputs, previewSrcMap],
  )
  const previewingIndex = useMemo(
    () => outputCards.findIndex((item) => item.id === previewingOutput?.id),
    [outputCards, previewingOutput],
  )

  const clampPreviewOffset = (offsetX: number, offsetY: number, scale: number) => {
    const stage = lightboxStageRef.current
    const image = lightboxImageRef.current

    if (!stage || !image) {
      return { x: offsetX, y: offsetY }
    }

    const scaledWidth = image.clientWidth * scale
    const scaledHeight = image.clientHeight * scale
    const maxX = Math.max(0, (scaledWidth - stage.clientWidth) / 2 + 24)
    const maxY = Math.max(0, (scaledHeight - stage.clientHeight) / 2 + 24)

    return {
      x: Math.max(-maxX, Math.min(maxX, offsetX)),
      y: Math.max(-maxY, Math.min(maxY, offsetY)),
    }
  }

  const togglePreviewZoom = () => {
    const image = lightboxImageRef.current
    if (!image) {
      return
    }

    if (Math.abs(previewScale - 1) < 0.05) {
      const actualScale = Math.min(
        3,
        Math.max(
          1,
          image.naturalWidth > 0 ? image.naturalWidth / Math.max(image.clientWidth, 1) : 1,
          image.naturalHeight > 0 ? image.naturalHeight / Math.max(image.clientHeight, 1) : 1,
        ),
      )
      setPreviewScale(actualScale)
      setPreviewOffset(clampPreviewOffset(0, 0, actualScale))
      return
    }

    setPreviewScale(1)
    setPreviewOffset({ x: 0, y: 0 })
  }

  useEffect(() => {
    const updateAnchor = () => {
      const width = window.innerWidth
      const height = window.innerHeight
      setAnchor((current) => ({
        x: Math.min(current.x, Math.max(margin, width - launcherSize - margin)),
        y:
          current.y === 0
            ? height - launcherSize - margin
            : Math.min(current.y, Math.max(margin, height - launcherSize - margin)),
      }))
    }

    updateAnchor()
    window.addEventListener('resize', updateAnchor)
    return () => window.removeEventListener('resize', updateAnchor)
  }, [])

  useEffect(() => {
    const clearSession = () => {
      void invokeBackend<void>('clear_session_outputs').catch(() => undefined)
    }

    window.addEventListener('beforeunload', clearSession)
    return () => window.removeEventListener('beforeunload', clearSession)
  }, [])

  useEffect(() => {
    void invokeBackend<RuntimeDiagnostics>('runtime_diagnostics')
      .then((diagnostics) => {
        const hasPdfiumCandidate = diagnostics.pdfiumCandidates.some((item) =>
          item.startsWith('exists:'),
        )
        if (!hasPdfiumCandidate) {
          setStatusText(`未检测到 ${diagnostics.pdfiumLibraryName}，PDF 转图片可能无法使用`)
        }
      })
      .catch((error) => {
        setStatusText(getErrorMessage(error, '运行环境检查失败'))
      })
  }, [])

  useEffect(() => {
    const unlistenPromise = getCurrentWindow().listen<ConversionProgressEvent>(
      'conversion-progress',
      (event) => {
        const payload = event.payload
        if (!payload || payload.runId !== activeRunIdRef.current) {
          return
        }

        setProgress(payload.progress)
        if (payload.output) {
          const nextOutput = payload.output
          setOutputs((current) => {
            if (current.some((item) => item.id === nextOutput.id)) {
              return current
            }
            return [...current, nextOutput]
          })
        }
      },
    )

    return () => {
      void unlistenPromise.then((unlisten) => unlisten())
    }
  }, [])

  useEffect(() => {
    const previewTargets = outputs.filter(
      (item) => item.previewPath && !previewSrcMap[item.id],
    )

    if (previewTargets.length === 0) {
      return
    }

    previewTargets.forEach((item) => {
      void invokeBackend<string>('load_preview_data', { path: item.previewPath })
        .then((dataUrl) => {
          setPreviewSrcMap((current) => ({ ...current, [item.id]: dataUrl }))
        })
        .catch(() => undefined)
    })
  }, [outputs, previewSrcMap])

  useEffect(() => {
    if (!menuOpen) {
      return
    }

    const handlePointerDownOutside = (event: MouseEvent) => {
      if (launcherLayerRef.current?.contains(event.target as Node)) {
        return
      }

      setMenuOpen(false)
      setHoveredTool(null)
    }

    document.addEventListener('pointerdown', handlePointerDownOutside)
    return () => document.removeEventListener('pointerdown', handlePointerDownOutside)
  }, [menuOpen])

  useEffect(() => {
    if (!previewingOutput) {
      return
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPreviewingOutput(null)
        setPreviewScale(1)
        setPreviewOffset({ x: 0, y: 0 })
        return
      }

      if (event.key === 'ArrowRight' && previewingIndex >= 0 && previewingIndex < outputCards.length - 1) {
        setPreviewingOutput(outputCards[previewingIndex + 1])
        setPreviewScale(1)
        setPreviewOffset({ x: 0, y: 0 })
      }

      if (event.key === 'ArrowLeft' && previewingIndex > 0) {
        setPreviewingOutput(outputCards[previewingIndex - 1])
        setPreviewScale(1)
        setPreviewOffset({ x: 0, y: 0 })
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [outputCards, previewingIndex, previewingOutput])

  const snapToNearestCorner = (x: number, y: number) => {
    const width = window.innerWidth
    const height = window.innerHeight
    const left = margin
    const right = width - launcherSize - margin
    const top = margin
    const bottom = height - launcherSize - margin
    const corners = [
      { x: left, y: top },
      { x: right, y: top },
      { x: left, y: bottom },
      { x: right, y: bottom },
    ]

    return corners.reduce((closest, corner) => {
      const currentDistance = Math.hypot(x - corner.x, y - corner.y)
      const bestDistance = Math.hypot(x - closest.x, y - closest.y)
      return currentDistance < bestDistance ? corner : closest
    })
  }

  const rehydrateImageDetails = (items: SourceItem[]) =>
    items.map((item, index) => ({
      ...item,
      detail: item.kind === 'pdf' ? 'PDF 文档 · 待拆分' : `图片素材 · 顺序 ${index + 1}`,
    }))

  const applySourcePaths = async (paths: string[]) => {
    const resolvedImports = await invokeBackend<ResolvedImport[]>('resolve_import_paths', { paths })
    const nextSources = rehydrateImageDetails(
      resolvedImports
        .map((item) => item.path)
        .map((path, index) => describeSource(path, index))
        .filter((item): item is SourceItem => Boolean(item)),
    )

    setSources(nextSources)
    setOutputs([])
    setPreviewSrcMap({})
    setErrors([])
    setProgress({ current: 0, total: 0, label: '尚未开始' })
    setStatusText(nextSources.length > 0 ? `已导入 ${nextSources.length} 个文件` : '没有可用文件')
  }

  const pickFiles = async () => {
    const selected = await open({
      multiple: true,
      filters: [
        { name: 'PDF', extensions: ['pdf'] },
        { name: 'Images', extensions: imageExtensions },
      ],
    })

    if (!selected) {
      return
    }

    await applySourcePaths(Array.isArray(selected) ? selected : [selected])
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    const files = Array.from(event.dataTransfer.files).map(getFilePath).filter(Boolean)

    if (files.length === 0) {
      setStatusText('当前拖拽内容没有可读取的本地路径')
      return
    }

    void applySourcePaths(files)
  }

  const removeSource = (id: string) => {
    const nextSources = rehydrateImageDetails(sources.filter((item) => item.id !== id))
    setSources(nextSources)
    setOutputs([])
    setPreviewSrcMap({})
    setErrors([])
    setProgress({ current: 0, total: 0, label: '尚未开始' })
    if (nextSources.length === 0) {
      setStatusText('已清空输入列表')
    } else {
      setStatusText(`已移除 1 个文件，还剩 ${nextSources.length} 个`)
    }
  }

  const moveSource = (fromId: string, toId: string) => {
    if (fromId === toId) {
      return
    }

    const fromIndex = sources.findIndex((item) => item.id === fromId)
    const toIndex = sources.findIndex((item) => item.id === toId)
    if (fromIndex < 0 || toIndex < 0) {
      return
    }

    const nextSources = rehydrateImageDetails(reorder(sources, fromIndex, toIndex))
    setSources(nextSources)
  }

  const runAction = async (mode: 'pdf-to-images' | 'images-to-pdf') => {
    const pdfSources = sources.filter((item) => item.kind === 'pdf')
    const imageSources = sources.filter((item) => item.kind === 'image')

    if (mode === 'pdf-to-images' && pdfSources.length === 0) {
      setStatusText('先导入至少 1 个 PDF 文件')
      return
    }

    if (mode === 'images-to-pdf' && imageSources.length === 0) {
      setStatusText('先导入至少 1 张图片')
      return
    }

    setIsBusy(true)
    setErrors([])
    setOutputs([])
    setPreviewSrcMap({})
    setProgress({
      current: 0,
      total: mode === 'pdf-to-images' ? Math.max(pdfSources.length, 1) : imageSources.length,
      label: '任务启动中',
    })
    setStatusText(mode === 'pdf-to-images' ? '正在拆分 PDF...' : '正在合并图片...')
    const runId = `${mode}-${Date.now()}`
    activeRunIdRef.current = runId

    try {
      const result = await invokeBackend<ConversionSummary>('run_conversion', {
        mode,
        paths: (mode === 'pdf-to-images' ? pdfSources : imageSources).map((item) => item.path),
        params:
          mode === 'pdf-to-images'
            ? (pdfParamsEnabled ? pdfImageParams : undefined)
            : (imageParamsEnabled ? imagePdfParams : undefined),
        runId,
      })

      setOutputs(result.outputs)
      setErrors(result.errors)
      setProgress(result.progress)
      if (result.outputDir) {
        setSessionBufferPath(result.outputDir)
      }
      setStatusText(result.note)
    } catch (error) {
      const message = getErrorMessage(error, '转换失败')
      setErrors([{ title: '任务执行失败', detail: message }])
      setStatusText(message)
    } finally {
      activeRunIdRef.current = null
      setIsBusy(false)
    }
  }

  const exportResults = async () => {
    if (outputs.length === 0) {
      setStatusText('右侧缓冲区里还没有结果可以导出')
      return
    }

    const selected = await open({
      directory: true,
      multiple: false,
    })

    if (typeof selected !== 'string') {
      return
    }

    try {
      const exported = await invokeBackend<OutputItem[]>('export_outputs', {
        outputs: outputs.map((item) => item.path),
        destinationDir: selected,
      })
      setStatusText(`已导出 ${exported.length} 个结果到 ${selected}`)
    } catch (error) {
      setStatusText(getErrorMessage(error, '导出失败'))
    }
  }

  const exportSelectedResults = async () => {
    const selection = window.getSelection()?.toString().trim() ?? ''
    if (!selection) {
      setStatusText('先在输出区选中文件名')
      return
    }

    const selectedOutputPaths = outputs
      .filter((item) => selection.includes(item.label))
      .map((item) => item.path)

    if (selectedOutputPaths.length === 0) {
      setStatusText('当前选区里没有匹配到可导出的结果')
      return
    }

    const selected = await open({
      directory: true,
      multiple: false,
    })

    if (typeof selected !== 'string') {
      return
    }

    try {
      const exported = await invokeBackend<OutputItem[]>('export_outputs', {
        outputs: selectedOutputPaths,
        destinationDir: selected,
      })
      setStatusText(`已导出 ${exported.length} 个选中结果到 ${selected}`)
    } catch (error) {
      setStatusText(getErrorMessage(error, '导出选中项失败'))
    }
  }

  const copyResultPaths = async () => {
    if (outputs.length === 0) {
      setStatusText('右侧缓冲区里还没有结果可以复制')
      return
    }

    const text = outputs.map((item) => item.path).join('\n')
    try {
      await navigator.clipboard.writeText(text)
      setStatusText('已复制结果路径列表')
    } catch {
      setStatusText('复制失败，请检查系统剪贴板权限')
    }
  }

  const clearResults = async () => {
    setOutputs([])
    setPreviewSrcMap({})
    setErrors([])
    setProgress({ current: 0, total: 0, label: '尚未开始' })
    setSessionBufferPath('')
    setStatusText('已清空右侧缓冲区')
    try {
      await invokeBackend<void>('clear_session_outputs')
    } catch {
      return
    }
  }

  const clearSelectedResults = () => {
    const selection = window.getSelection()?.toString().trim() ?? ''
    if (!selection) {
      setStatusText('先在输出区选中文件名')
      return
    }

    const selectedIds = outputs
      .filter((item) => selection.includes(item.label))
      .map((item) => item.id)

    if (selectedIds.length === 0) {
      setStatusText('当前选区里没有匹配到可清理的结果')
      return
    }

    const nextOutputs = outputs.filter((item) => !selectedIds.includes(item.id))
    setOutputs(nextOutputs)
    setPreviewSrcMap((current) =>
      Object.fromEntries(Object.entries(current).filter(([id]) => !selectedIds.includes(id))),
    )
    setStatusText(`已从缓冲区移除 ${outputs.length - nextOutputs.length} 个结果`)
  }

  const handlePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    dragRef.current = {
      active: true,
      moved: false,
      pointerOffsetX: event.clientX - bounds.left,
      pointerOffsetY: event.clientY - bounds.top,
      width: bounds.width,
      height: bounds.height,
    }

    event.currentTarget.setPointerCapture(event.pointerId)
    setHoveredTool(null)
    setMenuOpen(false)
  }

  const handlePointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    if (!dragRef.current.active) {
      return
    }

    const nextX = event.clientX - dragRef.current.pointerOffsetX
    const nextY = event.clientY - dragRef.current.pointerOffsetY
    const maxX = window.innerWidth - dragRef.current.width - margin
    const maxY = window.innerHeight - dragRef.current.height - margin

    if (Math.abs(nextX - anchor.x) > 3 || Math.abs(nextY - anchor.y) > 3) {
      dragRef.current.moved = true
    }

    setAnchor({
      x: Math.min(Math.max(margin, nextX), maxX),
      y: Math.min(Math.max(margin, nextY), maxY),
    })
  }

  const handlePointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    if (!dragRef.current.active) {
      return
    }

    dragRef.current.active = false
    event.currentTarget.releasePointerCapture(event.pointerId)
    const snapped = snapToNearestCorner(anchor.x, anchor.y)
    animate(anchor.x, snapped.x, {
      duration: 0.24,
      onUpdate: (value) => setAnchor((current) => ({ ...current, x: value })),
    })
    animate(anchor.y, snapped.y, {
      duration: 0.24,
      onUpdate: (value) => setAnchor((current) => ({ ...current, y: value })),
    })
  }

  return (
    <main className="app-shell">
      <div className="ambient ambient-left" />
      <div className="ambient ambient-right" />

      <section className="workspace-card">
        <header className="workspace-banner">
          <div>
            <p className="section-kicker">工作区</p>
            <h2>{currentTool.title}</h2>
            <p>{currentTool.subtitle}</p>
          </div>
          <div className="status-badge">{statusText}</div>
        </header>

        {activeTool === 'blank' ? (
          <section className="blank-workspace">
            <div className="blank-orb">{currentTool.icon}</div>
            <h3>这里是第二个工具栏目</h3>
            <p>
              这个页面目前保持空白，主要用来测试悬浮工具气泡的展开、收起、标题跟随和页面切换过渡是否自然。
            </p>
          </section>
        ) : (
        <div className="workspace-grid">
          <aside className="pane pane-source">
            <div className="pane-head">
              <div>
                <h3>输入区</h3>
              </div>
              <span>{sources.length} 项</span>
            </div>

            <div
              className="drop-zone"
              onDragOver={(event) => event.preventDefault()}
              onDrop={handleDrop}
            >
              <strong>拖入 PDF 或图片</strong>
              <p>PDF 会拆页导出，图片会按当前顺序参与合并。</p>
              <button type="button" className="inline-button" onClick={pickFiles}>
                选择文件
              </button>
            </div>

            {sources.length > 0 ? (
              <ul className="item-list source-list">
                {sources.map((item, index) => (
                  <li
                    key={item.id}
                    className={`source-item ${draggingSourceId === item.id ? 'is-dragging' : ''}`}
                    draggable={item.kind === 'image'}
                    onDragStart={() => setDraggingSourceId(item.id)}
                    onDragEnd={() => setDraggingSourceId(null)}
                    onDragOver={(event) => {
                      if (draggingSourceId && draggingSourceId !== item.id) {
                        event.preventDefault()
                      }
                    }}
                    onDrop={(event) => {
                      event.preventDefault()
                      if (draggingSourceId) {
                        moveSource(draggingSourceId, item.id)
                      }
                      setDraggingSourceId(null)
                    }}
                  >
                    <span className={`type-pill type-${item.kind}`}>
                      {item.kind === 'pdf' ? 'PDF' : 'IMG'}
                    </span>
                    <div className="source-copy">
                      <strong>{item.name}</strong>
                      <p>{item.detail}</p>
                    </div>
                    <span className="order-mark">{index + 1}</span>
                    <button
                      type="button"
                      className="remove-button"
                      onClick={() => removeSource(item.id)}
                      aria-label={`移除 ${item.name}`}
                    >
                      移除
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="empty-source-state">
                <strong>这里会显示你刚导入的文件</strong>
                <p>导入后会直接出现在这个区域，图片也可以在这里拖动调整顺序。</p>
              </div>
            )}

            <div className="params-panel">
              <div className="params-head">
                <strong>参数面板</strong>
                <span>默认直接处理，按需展开调整</span>
              </div>

              <div className="action-row action-row-top">
                <button
                  type="button"
                  className="ghost-button"
                  disabled={isBusy || !hasPdfSources}
                  onClick={() => runAction('pdf-to-images')}
                >
                  PDF 转图片
                </button>
                <button
                  type="button"
                  className="solid-button"
                  disabled={isBusy || !hasImageSources}
                  onClick={() => runAction('images-to-pdf')}
                >
                  图片合并 PDF
                </button>
              </div>

              {showPdfPanel && (
                <div className="params-group">
                  <label className="param-toggle">
                    <input
                      type="checkbox"
                      checked={pdfParamsEnabled}
                      onChange={(event) => setPdfParamsEnabled(event.target.checked)}
                    />
                    <span>参数调整</span>
                  </label>

                  {pdfParamsEnabled && (
                    <div className="field-grid">
                  <label className="field">
                    <span>输出格式</span>
                    <select
                      value={pdfImageParams.format}
                      onChange={(event) =>
                        setPdfImageParams((current) => ({
                          ...current,
                          format: event.target.value as PdfImageFormat,
                        }))
                      }
                    >
                      <option value="png">PNG</option>
                      <option value="jpg">JPG</option>
                    </select>
                  </label>

                  <label className="field">
                    <span>清晰度</span>
                    <select
                      value={pdfImageParams.quality}
                      onChange={(event) =>
                        setPdfImageParams((current) => ({
                          ...current,
                          quality: event.target.value as PdfImageQuality,
                        }))
                      }
                    >
                      <option value="standard">标准</option>
                      <option value="hd">高清</option>
                      <option value="print">打印</option>
                    </select>
                  </label>

                  <label className="field">
                    <span>尺寸模式</span>
                    <select
                      value={pdfImageParams.sizeMode}
                      onChange={(event) =>
                        setPdfImageParams((current) => ({
                          ...current,
                          sizeMode: event.target.value as PdfImageParams['sizeMode'],
                        }))
                      }
                    >
                      <option value="quality">跟随清晰度</option>
                      <option value="long-edge">限制长边</option>
                      <option value="width">固定宽度</option>
                    </select>
                  </label>

                  <label className="field">
                    <span>尺寸值(px)</span>
                    <input
                      type="number"
                      min="400"
                      max="6000"
                      step="100"
                      value={pdfImageParams.sizeValue}
                      onChange={(event) =>
                        setPdfImageParams((current) => ({
                          ...current,
                          sizeValue: Number(event.target.value) || 2200,
                        }))
                      }
                      disabled={pdfImageParams.sizeMode === 'quality'}
                    />
                  </label>

                  <label className="field field-wide">
                    <span>页码范围</span>
                    <input
                      value={pdfImageParams.pageRange}
                      onChange={(event) =>
                        setPdfImageParams((current) => ({
                          ...current,
                          pageRange: event.target.value,
                        }))
                      }
                      placeholder="留空为全部，例如 1-3,5,8-10"
                    />
                    <div className="field-help">
                      <span>支持单页、区间和组合写法</span>
                      <strong>示例：1-3,5,8-10</strong>
                    </div>
                  </label>

                  <label className="field field-wide">
                    <span>命名模板</span>
                    <input
                      value={pdfImageParams.namingTemplate}
                      onChange={(event) =>
                        setPdfImageParams((current) => ({
                          ...current,
                          namingTemplate: event.target.value,
                        }))
                      }
                      placeholder="page-{page}"
                    />
                    <div className="field-help">
                      <span>可用变量：`{'{page}'}` 表示页码</span>
                      <strong>示例：{pageNamePreview}</strong>
                    </div>
                  </label>
                    </div>
                  )}
                </div>
              )}

              {showImagePanel && (
                <div className="params-group">
                  <label className="param-toggle">
                    <input
                      type="checkbox"
                      checked={imageParamsEnabled}
                      onChange={(event) => setImageParamsEnabled(event.target.checked)}
                    />
                    <span>参数调整</span>
                  </label>

                  {imageParamsEnabled && (
                    <div className="field-grid">
                  <label className="field">
                    <span>纸张尺寸</span>
                    <select
                      value={imagePdfParams.pageSize}
                      onChange={(event) =>
                        setImagePdfParams((current) => ({
                          ...current,
                          pageSize: event.target.value as PdfPageSize,
                        }))
                      }
                    >
                      <option value="auto">跟随图片</option>
                      <option value="a4">A4</option>
                      <option value="letter">Letter</option>
                    </select>
                  </label>

                  <label className="field">
                    <span>方向</span>
                    <select
                      value={imagePdfParams.orientation}
                      onChange={(event) =>
                        setImagePdfParams((current) => ({
                          ...current,
                          orientation: event.target.value as PdfOrientation,
                        }))
                      }
                    >
                      <option value="auto">自动</option>
                      <option value="portrait">纵向</option>
                      <option value="landscape">横向</option>
                    </select>
                  </label>

                  <label className="field">
                    <span>边距(mm)</span>
                    <input
                      type="number"
                      min="0"
                      max="40"
                      value={imagePdfParams.marginMm}
                      onChange={(event) =>
                        setImagePdfParams((current) => ({
                          ...current,
                          marginMm: Number(event.target.value) || 0,
                        }))
                      }
                    />
                  </label>

                  <label className="field">
                    <span>摆放模式</span>
                    <select
                      value={imagePdfParams.fitMode}
                      onChange={(event) =>
                        setImagePdfParams((current) => ({
                          ...current,
                          fitMode: event.target.value as ImagePdfParams['fitMode'],
                        }))
                      }
                    >
                      <option value="contain">等比适应</option>
                      <option value="cover">铺满裁切</option>
                    </select>
                  </label>

                  <label className="field field-wide">
                    <span>PDF 文件名</span>
                    <input
                      value={imagePdfParams.fileName}
                      onChange={(event) =>
                        setImagePdfParams((current) => ({
                          ...current,
                          fileName: event.target.value,
                        }))
                      }
                      placeholder="merged-images"
                    />
                    <div className="field-help">
                      <span>会自动清理非法文件名字符</span>
                      <strong>示例：{pdfNamePreview}</strong>
                    </div>
                  </label>
                    </div>
                  )}
                </div>
              )}

              <div className="output-control output-control-inline">
                <div>
                  <strong>会话缓冲区</strong>
                  <p>{sessionBufferPath || '尚未生成结果，本次启动结束后会自动清空。'}</p>
                </div>
              </div>
            </div>
          </aside>

          <section className="pane pane-output">
            <div className="pane-head">
              <div>
                <h3>输出区</h3>
              </div>
              <span>{outputs.length} 个结果</span>
            </div>

            <div className="progress-panel">
              <div className="progress-meta">
                <strong>任务进度</strong>
                <span>{progress.label}</span>
              </div>
              <div className="progress-track">
                <div className="progress-bar" style={{ width: `${progressPercent}%` }} />
              </div>
            </div>

            <div className="buffer-actions">
              <button type="button" className="ghost-button compact-button" onClick={copyResultPaths}>
                复制路径
              </button>
              <button type="button" className="ghost-button compact-button" onClick={exportResults}>
                导出到本地
              </button>
              <button
                type="button"
                className="ghost-button compact-button"
                onClick={exportSelectedResults}
              >
                导出选中项
              </button>
              <button
                type="button"
                className="ghost-button compact-button"
                onClick={clearSelectedResults}
              >
                清理选中项
              </button>
              <button type="button" className="ghost-button compact-button" onClick={clearResults}>
                清空缓冲区
              </button>
              <div className="view-switch">
                <button
                  type="button"
                  className={`ghost-button compact-button ${outputViewMode === 'grid' ? 'is-active' : ''}`}
                  onClick={() => setOutputViewMode('grid')}
                >
                  缩略图
                </button>
                <button
                  type="button"
                  className={`ghost-button compact-button ${outputViewMode === 'list' ? 'is-active' : ''}`}
                  onClick={() => setOutputViewMode('list')}
                >
                  列表
                </button>
              </div>
            </div>

            {errors.length > 0 && (
              <div className="error-panel">
                <div className="progress-meta">
                  <strong>错误明细</strong>
                  <span>{errors.length} 条</span>
                </div>
                <ul className="error-list">
                  {errors.map((error, index) => (
                    <li key={`${error.title}-${index}`} className="error-item">
                      <strong>{error.title}</strong>
                      <p>{error.detail}</p>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className={`output-grid output-grid-${outputViewMode}`}>
              {outputCards.map((item, index) => (
                <article key={item.id} className={`output-card output-card-${outputViewMode}`}>
                  <button
                    type="button"
                    className="preview-button"
                    onDoubleClick={() => {
                      setPreviewingOutput(item)
                      setPreviewScale(1)
                      setPreviewOffset({ x: 0, y: 0 })
                    }}
                  >
                    <div className="page-preview">
                      {item.previewSrc ? (
                        <img
                          className="preview-image"
                          src={item.previewSrc}
                          alt={item.label}
                          loading="lazy"
                        />
                      ) : (
                        <span>{String(index + 1).padStart(2, '0')}</span>
                      )}
                    </div>
                  </button>
                  <div className="output-copy">
                    <strong>{item.label}</strong>
                    <p>{item.detail}</p>
                  </div>
                </article>
              ))}
            </div>
          </section>
        </div>
        )}
      </section>

      {previewingOutput && (
        <div className="lightbox-backdrop" onClick={() => setPreviewingOutput(null)}>
          <div className="lightbox-shell" onClick={(event) => event.stopPropagation()}>
            <div className="lightbox-head">
              <strong>{previewingOutput.label}</strong>
              <div className="lightbox-toolbar">
                <button
                  type="button"
                  className="ghost-button compact-button"
                  disabled={previewingIndex <= 0}
                  onClick={() => {
                    if (previewingIndex > 0) {
                      setPreviewingOutput(outputCards[previewingIndex - 1])
                      setPreviewScale(1)
                      setPreviewOffset({ x: 0, y: 0 })
                    }
                  }}
                >
                  上一张
                </button>
                <button
                  type="button"
                  className="ghost-button compact-button"
                  disabled={previewingIndex < 0 || previewingIndex >= outputCards.length - 1}
                  onClick={() => {
                    if (previewingIndex >= 0 && previewingIndex < outputCards.length - 1) {
                      setPreviewingOutput(outputCards[previewingIndex + 1])
                      setPreviewScale(1)
                      setPreviewOffset({ x: 0, y: 0 })
                    }
                  }}
                >
                  下一张
                </button>
                <button
                  type="button"
                  className="ghost-button compact-button"
                  onClick={() => {
                    const nextScale = Math.max(0.5, Number((previewScale - 0.1).toFixed(2)))
                    setPreviewScale(nextScale)
                    setPreviewOffset((current) => clampPreviewOffset(current.x, current.y, nextScale))
                  }}
                >
                  缩小
                </button>
                <button
                  type="button"
                  className="ghost-button compact-button"
                  onClick={() => {
                    const nextScale = Math.min(3, Number((previewScale + 0.1).toFixed(2)))
                    setPreviewScale(nextScale)
                    setPreviewOffset((current) => clampPreviewOffset(current.x, current.y, nextScale))
                  }}
                >
                  放大
                </button>
                <span className="lightbox-counter">
                  {previewingIndex >= 0 ? `${previewingIndex + 1} / ${outputCards.length}` : `0 / ${outputCards.length}`}
                </span>
                <button
                  type="button"
                  className="ghost-button compact-button"
                  onClick={() => {
                    setPreviewingOutput(null)
                    setPreviewScale(1)
                    setPreviewOffset({ x: 0, y: 0 })
                  }}
                >
                  关闭
                </button>
              </div>
            </div>
            <div
              ref={lightboxStageRef}
              className="lightbox-stage"
              onWheel={(event) => {
                event.preventDefault()
                const nextScale = Math.min(
                  3,
                  Math.max(0.5, Number((previewScale + (event.deltaY < 0 ? 0.12 : -0.12)).toFixed(2))),
                )
                setPreviewScale(nextScale)
                setPreviewOffset((current) => clampPreviewOffset(current.x, current.y, nextScale))
              }}
            >
              {previewSrcMap[previewingOutput.id] ? (
                <img
                  ref={lightboxImageRef}
                  className="lightbox-image"
                  src={previewSrcMap[previewingOutput.id]}
                  alt={previewingOutput.label}
                  style={{ transform: `translate(${previewOffset.x}px, ${previewOffset.y}px) scale(${previewScale})` }}
                  onDoubleClick={togglePreviewZoom}
                  onPointerDown={(event) => {
                    previewDragRef.current = {
                      dragging: true,
                      startX: event.clientX,
                      startY: event.clientY,
                      originX: previewOffset.x,
                      originY: previewOffset.y,
                    }
                    event.currentTarget.setPointerCapture(event.pointerId)
                  }}
                  onPointerMove={(event) => {
                    if (!previewDragRef.current.dragging) {
                      return
                    }

                    const nextOffset = clampPreviewOffset(
                      previewDragRef.current.originX + (event.clientX - previewDragRef.current.startX),
                      previewDragRef.current.originY + (event.clientY - previewDragRef.current.startY),
                      previewScale,
                    )
                    setPreviewOffset(nextOffset)
                  }}
                  onPointerUp={(event) => {
                    previewDragRef.current.dragging = false
                    event.currentTarget.releasePointerCapture(event.pointerId)
                  }}
                  onPointerCancel={() => {
                    previewDragRef.current.dragging = false
                  }}
                />
              ) : (
                <div className="lightbox-fallback">当前结果暂时没有可预览图像</div>
              )}
            </div>
          </div>
        </div>
      )}

      <div
        ref={launcherLayerRef}
        className={`launcher-layer corner-${currentCorner} title-${titleSide} stack-${stackDirection}`}
        style={{ left: anchor.x, top: anchor.y }}
      >
        <AnimatePresence>
          {menuOpen &&
            inactiveTools.map((tool, index) => {
              const offset = (launcherSize + launcherGap) * (index + 1)
              const x = 0
              const y = stackDirection === 'up' ? -offset : offset
              const expanded = hoveredTool === tool.id

              return (
                <motion.button
                  key={tool.id}
                  type="button"
                  className={`tool-orb ${expanded ? 'is-expanded' : ''}`}
                  initial={{ opacity: 0, scale: 0.82, x: 0, y: 0 }}
                  animate={{ opacity: 1, scale: 1, x, y }}
                  exit={{ opacity: 0, scale: 0.82, x: 0, y: 0 }}
                  transition={{ type: 'spring', stiffness: 360, damping: 28, delay: index * 0.03 }}
                  style={{ backgroundImage: tool.color }}
                  onMouseEnter={() => setHoveredTool(tool.id)}
                  onMouseLeave={() => setHoveredTool(null)}
                  onClick={() => {
                    setActiveTool(tool.id)
                    setMenuOpen(false)
                    setHoveredTool(null)
                  }}
                >
                  <span className="orb-icon">{tool.icon}</span>
                  <span className="orb-title">{tool.title}</span>
                </motion.button>
              )
            })}
        </AnimatePresence>

        <motion.button
          type="button"
          className="launcher"
          style={{ backgroundImage: currentTool.color }}
          animate={{ scale: menuOpen ? 1.06 : 1 }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onClick={() => {
            if (!dragRef.current.moved) {
              setMenuOpen((open) => {
                const next = !open
                if (!next) {
                  setHoveredTool(null)
                }
                return next
              })
            }
          }}
        >
          <span className="launcher-icon">{currentTool.icon}</span>
          {menuOpen ? <span className="launcher-title">{currentTool.title}</span> : null}
        </motion.button>
      </div>
    </main>
  )
}

export default App
