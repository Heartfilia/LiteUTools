# LiteUtools

LiteUtools 是一个跨平台桌面工具合集原型，当前第一版先实现 `PDF / 图片转换` 工作台，并预留后续通过悬浮圆球切换更多功能模块的交互结构。

## 当前技术栈

- `Tauri 2`
- `React 19 + TypeScript`
- `Vite`
- `Framer Motion`
- `Zustand`
- `Rust` 作为本地文件处理层

## 已完成内容

- 整窗工作区布局
- 左下角可拖动悬浮圆球
- 释放后自动吸附到最近角
- 点击圆球展开圆盘式功能切换入口
- 鼠标悬停时展示功能标题
- 当前功能默认在展开态展示标题
- `PDF / 图片转换` 的左右分栏工作台
- 文件选择与拖拽导入
- 输入列表移除
- 图片拖拽重排
- 图片按导入顺序合并为 PDF
- PDF 拆页导出为 PNG
- 右侧会话缓冲区
- 任务进度与错误明细
- 结果导出到本地
- 结果路径复制
- Tauri 前后端通信与 Rust 转换命令

## 本地开发

先安装前端依赖：

```bash
npm install
```

前端调试：

```bash
npm run dev
```

前端构建：

```bash
npm run build
```

Tauri 桌面调试：

```bash
npm run tauri:dev
```

Tauri 桌面打包：

```bash
npm run tauri:build
```

## PDF 转图片的额外要求

`图片 -> PDF` 已经是纯 Rust 方案，直接可用。

`PDF -> 图片` 依赖 `Pdfium` 动态库运行时加载。

项目已经提供自动下载脚本：

```bash
npm run pdfium:setup
```

只做检查、不下载：

```bash
npm run pdfium:check
```

脚本会把库放到：

- `resources/pdfium/macos/libpdfium.dylib`
- `resources/pdfium/windows/pdfium.dll`

这些文件也会在 `tauri build` 时自动带进安装包。

现在 `npm run tauri:dev` 和 `npm run tauri:build` 会先自动检查并补齐 `Pdfium`，所以日常只需要记这两个命令。

## 当前行为

- 图片合并 PDF 时，按左侧列表当前顺序生成页面。
- 右侧结果区是当前启动会话的临时缓冲区，结果先写入应用缓存目录下的会话目录。
- 每次重新启动应用，右侧缓冲区会重新开始；关闭应用时会尝试清理本次会话结果。
- 可以从右侧复制结果路径列表，也可以手动把当前结果导出到本地目录。
- PDF 拆页时，会在会话缓冲区下为每个 PDF 创建 `文件名_pages/` 子目录。
- 图片合并 PDF 时，会在会话缓冲区下生成 `merged-images.pdf`。

## 下一步建议

1. 增加文件命名规则和重名冲突处理。
2. 做输出结果缩略图预览与打开所在目录。
3. 给 PDF 和图片分别补更多参数选项。
4. 增加批量任务队列和历史记录。
5. 继续补第二个功能模块，并接入圆盘切换体系。
