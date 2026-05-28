import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type PointerEvent,
  type WheelEvent,
} from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { AnimatePresence, animate, motion } from 'framer-motion'
import './App.css'

type ToolId = 'convert' | 'text-compare'
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

type SelectionBox = {
  active: boolean
  x: number
  y: number
  width: number
  height: number
}

type ToolTransition = {
  id: string
  tool: ToolDefinition
  startX: number
  startY: number
  targetX: number
  targetY: number
  radius: number
}

type DiffLine = {
  left: string
  right: string
  leftChanged: boolean
  rightChanged: boolean
  kind: 'same' | 'changed' | 'added' | 'removed'
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
    id: 'text-compare',
    title: '文本对比',
    subtitle: '左右粘贴两段文本，快速查看逐行差异并清空重输。',
    icon: 'TXT',
    color: 'linear-gradient(135deg, #5d8cff 0%, #8ec5ff 100%)',
  },
]

const launcherGap = 16
const launcherSize = 60
const margin = 28
const imageExtensions = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tiff']
const appVersion = __APP_VERSION__

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

function canUseTauriWindowApi() {
  if (typeof window === 'undefined') {
    return false
  }

  return '__TAURI_INTERNALS__' in window || '__TAURI__' in window
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

async function dataUrlToBlob(dataUrl: string) {
  const response = await fetch(dataUrl)
  return response.blob()
}

function isPrimaryImageOutput(item: OutputItem) {
  return item.kind === 'image'
}

function isEditableTarget(target: EventTarget | null) {
  const element = target as HTMLElement | null
  if (!element) {
    return false
  }

  const tagName = element.tagName
  return (
    element.isContentEditable ||
    tagName === 'INPUT' ||
    tagName === 'TEXTAREA' ||
    tagName === 'SELECT'
  )
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

function buildDiffLines(leftText: string, rightText: string): DiffLine[] {
  if (!leftText && !rightText) {
    return []
  }

  const leftLines = leftText.replace(/\r\n/g, '\n').split('\n')
  const rightLines = rightText.replace(/\r\n/g, '\n').split('\n')
  const total = Math.max(leftLines.length, rightLines.length, 1)
  const lines: DiffLine[] = []

  for (let index = 0; index < total; index += 1) {
    const left = leftLines[index] ?? ''
    const right = rightLines[index] ?? ''
    const hasLeft = index < leftLines.length
    const hasRight = index < rightLines.length

    if (hasLeft && hasRight) {
      const changed = left !== right
      lines.push({
        left,
        right,
        leftChanged: changed,
        rightChanged: changed,
        kind: changed ? 'changed' : 'same',
      })
      continue
    }

    if (hasLeft) {
      lines.push({
        left,
        right: '',
        leftChanged: true,
        rightChanged: false,
        kind: 'removed',
      })
      continue
    }

    lines.push({
      left: '',
      right,
      leftChanged: false,
      rightChanged: true,
      kind: 'added',
    })
  }

  return lines
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
  const [, setSessionBufferPath] = useState('')
  const [pdfParamsEnabled, setPdfParamsEnabled] = useState(false)
  const [imageParamsEnabled, setImageParamsEnabled] = useState(false)
  const [leftCompareText, setLeftCompareText] = useState('')
  const [rightCompareText, setRightCompareText] = useState('')
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
  const [fullPreviewSrcMap, setFullPreviewSrcMap] = useState<Record<string, string>>({})
  const [outputViewMode, setOutputViewMode] = useState<OutputViewMode>('grid')
  const [selectedOutputIds, setSelectedOutputIds] = useState<string[]>([])
  const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null)
  const [previewingOutput, setPreviewingOutput] = useState<OutputItem | null>(null)
  const [previewScale, setPreviewScale] = useState(1)
  const [previewScaleDraft, setPreviewScaleDraft] = useState(100)
  const [previewOffset, setPreviewOffset] = useState({ x: 0, y: 0 })
  const [anchor, setAnchor] = useState({ x: margin, y: 0 })
  const [isLauncherDragging, setIsLauncherDragging] = useState(false)
  const [toolTransition, setToolTransition] = useState<ToolTransition | null>(null)
  const launcherLayerRef = useRef<HTMLDivElement | null>(null)
  const activeRunIdRef = useRef<string | null>(null)
  const transitionIdRef = useRef(0)
  const leftCompareRef = useRef<HTMLTextAreaElement | null>(null)
  const rightCompareRef = useRef<HTMLTextAreaElement | null>(null)
  const leftCompareLayerRef = useRef<HTMLDivElement | null>(null)
  const rightCompareLayerRef = useRef<HTMLDivElement | null>(null)
  const compareScrollSyncRef = useRef(false)
  const lastSelectedOutputIdRef = useRef<string | null>(null)
  const outputGridRef = useRef<HTMLDivElement | null>(null)
  const outputCardRefs = useRef<Record<string, HTMLElement | null>>({})
  const selectionDragRef = useRef<{
    active: boolean
    pointerId: number | null
    originX: number
    originY: number
    additive: boolean
    baseIds: string[]
    dragged: boolean
  }>({
    active: false,
    pointerId: null,
    originX: 0,
    originY: 0,
    additive: false,
    baseIds: [],
    dragged: false,
  })
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
    x: 0,
    y: 0,
    pointerOffsetX: 0,
    pointerOffsetY: 0,
    width: 0,
    height: 0,
  })
  const snapAnimationRef = useRef<ReturnType<typeof animate>[] | null>(null)

  const triggerToolSwitch = (tool: ToolDefinition, event: React.MouseEvent<HTMLButtonElement>) => {
    const sourceRect = event.currentTarget.getBoundingClientRect()
    const targetRect = launcherLayerRef.current?.getBoundingClientRect()

    if (!targetRect) {
      setActiveTool(tool.id)
      setMenuOpen(false)
      setHoveredTool(null)
      return
    }

    const targetX = targetRect.left + targetRect.width / 2
    const targetY = targetRect.top + targetRect.height / 2
    const farthestX = Math.max(targetX, window.innerWidth - targetX)
    const farthestY = Math.max(targetY, window.innerHeight - targetY)

    transitionIdRef.current += 1
    setToolTransition({
      id: `${tool.id}-${transitionIdRef.current}`,
      tool,
      startX: sourceRect.left + sourceRect.width / 2,
      startY: sourceRect.top + sourceRect.height / 2,
      targetX,
      targetY,
      radius: Math.hypot(farthestX, farthestY) + 96,
    })
    setMenuOpen(false)
    setHoveredTool(null)

    window.setTimeout(() => {
      setActiveTool(tool.id)
    }, 470)

    window.setTimeout(() => {
      setToolTransition(null)
    }, 1180)
  }

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
  const selectedOutputSet = useMemo(() => new Set(selectedOutputIds), [selectedOutputIds])
  const selectedOutputs = useMemo(
    () => outputs.filter((item) => selectedOutputSet.has(item.id)),
    [outputs, selectedOutputSet],
  )
  const selectedOutputCount = selectedOutputs.length
  const previewingIndex = useMemo(
    () => outputCards.findIndex((item) => item.id === previewingOutput?.id),
    [outputCards, previewingOutput],
  )
  const previewDisplaySrc = previewingOutput
    ? fullPreviewSrcMap[previewingOutput.id] || previewSrcMap[previewingOutput.id]
    : ''
  const diffLines = useMemo(
    () => buildDiffLines(leftCompareText, rightCompareText),
    [leftCompareText, rightCompareText],
  )
  const diffSummary = useMemo(
    () => ({
      changed: diffLines.filter((line) => line.kind === 'changed').length,
      added: diffLines.filter((line) => line.kind === 'added').length,
      removed: diffLines.filter((line) => line.kind === 'removed').length,
    }),
    [diffLines],
  )
  const syncCompareScroll = (source: 'left' | 'right') => {
    if (compareScrollSyncRef.current) {
      return
    }

    const sourceElement = source === 'left' ? leftCompareRef.current : rightCompareRef.current

    if (!sourceElement) {
      return
    }

    compareScrollSyncRef.current = true
    const top = sourceElement.scrollTop
    const left = sourceElement.scrollLeft
    if (source !== 'left' && leftCompareRef.current) {
      leftCompareRef.current.scrollTop = top
    }
    if (source !== 'right' && rightCompareRef.current) {
      rightCompareRef.current.scrollTop = top
    }
    if (source !== 'left' && leftCompareRef.current) {
      leftCompareRef.current.scrollLeft = left
    }
    if (source !== 'right' && rightCompareRef.current) {
      rightCompareRef.current.scrollLeft = left
    }
    if (leftCompareLayerRef.current && source === 'left') {
      leftCompareLayerRef.current.style.transform = `translate(${-left}px, ${-top}px)`
    }
    if (rightCompareLayerRef.current && source === 'right') {
      rightCompareLayerRef.current.style.transform = `translate(${-left}px, ${-top}px)`
    }
    if (source === 'left' && rightCompareLayerRef.current) {
      rightCompareLayerRef.current.style.transform = `translate(${-left}px, ${-top}px)`
    }
    if (source === 'right' && leftCompareLayerRef.current) {
      leftCompareLayerRef.current.style.transform = `translate(${-left}px, ${-top}px)`
    }
    window.requestAnimationFrame(() => {
      compareScrollSyncRef.current = false
    })
  }

  const selectOutputsInBox = (
    nextBox: SelectionBox,
    baseIds: string[],
    additive: boolean,
  ) => {
    const container = outputGridRef.current
    if (!container) {
      return
    }

    const containerRect = container.getBoundingClientRect()
    const hitIds = outputCards
      .filter((item) => {
        const element = outputCardRefs.current[item.id]
        if (!element) {
          return false
        }

        const rect = element.getBoundingClientRect()
        const left = rect.left - containerRect.left
        const top = rect.top - containerRect.top
        const right = left + rect.width
        const bottom = top + rect.height

        return !(
          right < nextBox.x ||
          left > nextBox.x + nextBox.width ||
          bottom < nextBox.y ||
          top > nextBox.y + nextBox.height
        )
      })
      .map((item) => item.id)

    setSelectedOutputIds(additive ? Array.from(new Set([...baseIds, ...hitIds])) : hitIds)
  }

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
        2,
        Math.max(
          1,
          image.naturalWidth > 0 ? image.naturalWidth / Math.max(image.clientWidth, 1) : 1,
          image.naturalHeight > 0 ? image.naturalHeight / Math.max(image.clientHeight, 1) : 1,
        ),
      )
      setPreviewScale(actualScale)
      setPreviewScaleDraft(Math.round(actualScale * 100))
      setPreviewOffset(clampPreviewOffset(0, 0, actualScale))
      return
    }

    setPreviewScale(1)
    setPreviewScaleDraft(100)
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
    if (!canUseTauriWindowApi()) {
      return
    }

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
    if (!previewingOutput || fullPreviewSrcMap[previewingOutput.id]) {
      return
    }

    const sourcePath =
      previewingOutput.kind === 'image' || previewingOutput.kind === 'pdf'
        ? previewingOutput.path
        : previewingOutput.previewPath

    if (!sourcePath) {
      return
    }

    void invokeBackend<string>('load_preview_data', { path: sourcePath })
      .then((dataUrl) => {
        setFullPreviewSrcMap((current) => ({ ...current, [previewingOutput.id]: dataUrl }))
      })
      .catch(() => undefined)
  }, [fullPreviewSrcMap, previewingOutput])

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

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code === 'Space' || event.key.startsWith('Arrow')) {
        event.preventDefault()
        event.stopPropagation()
      }

      if (event.key === 'Escape') {
        setPreviewingOutput(null)
        setPreviewScale(1)
        setPreviewScaleDraft(100)
        setPreviewOffset({ x: 0, y: 0 })
        return
      }

      if (
        (event.key === 'ArrowRight' || event.code === 'Space') &&
        previewingIndex >= 0 &&
        previewingIndex < outputCards.length - 1
      ) {
        setPreviewingOutput(outputCards[previewingIndex + 1])
        setPreviewScale(1)
        setPreviewScaleDraft(100)
        setPreviewOffset({ x: 0, y: 0 })
      }

      if (event.key === 'ArrowLeft' && previewingIndex > 0) {
        setPreviewingOutput(outputCards[previewingIndex - 1])
        setPreviewScale(1)
        setPreviewScaleDraft(100)
        setPreviewOffset({ x: 0, y: 0 })
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', handleKeyDown)
    }
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
    setSelectedOutputIds([])
    lastSelectedOutputIdRef.current = null
    setPreviewSrcMap({})
    setFullPreviewSrcMap({})
    setErrors([])
    setProgress({ current: 0, total: 0, label: '尚未开始' })
    setStatusText(nextSources.length > 0 ? `已导入 ${nextSources.length} 个文件` : '没有可用文件')
  }

  const pickFiles = async () => {
    const selected = await open({
      multiple: true,
      directory: false,
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
    setSelectedOutputIds([])
    lastSelectedOutputIdRef.current = null
    setPreviewSrcMap({})
    setFullPreviewSrcMap({})
    setErrors([])
    setProgress({ current: 0, total: 0, label: '尚未开始' })
    if (nextSources.length === 0) {
      setStatusText('已清空输入列表')
    } else {
      setStatusText(`已移除 1 个文件，还剩 ${nextSources.length} 个`)
    }
  }

  const moveSource = (id: string, direction: -1 | 1) => {
    const fromIndex = sources.findIndex((item) => item.id === id)
    if (fromIndex < 0) {
      return
    }

    const toIndex = fromIndex + direction
    if (toIndex < 0 || toIndex >= sources.length) {
      return
    }

    const nextSources = rehydrateImageDetails(reorder(sources, fromIndex, toIndex))
    setSources(nextSources)
  }

  const handleCompareWheel = (source: 'left' | 'right', event: WheelEvent<HTMLTextAreaElement>) => {
    const editor = source === 'left' ? leftCompareRef.current : rightCompareRef.current
    if (!editor) {
      return
    }

    event.preventDefault()
    event.stopPropagation()

    const horizontalDelta =
      event.shiftKey && Math.abs(event.deltaX) < Math.abs(event.deltaY) ? event.deltaY : event.deltaX
    editor.scrollLeft += horizontalDelta
    editor.scrollTop += event.shiftKey ? 0 : event.deltaY
    syncCompareScroll(source)
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
    setSelectedOutputIds([])
    lastSelectedOutputIdRef.current = null
    setPreviewSrcMap({})
    setFullPreviewSrcMap({})
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
    if (selectedOutputs.length === 0) {
      setStatusText('先点选要导出的结果')
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
        outputs: selectedOutputs.map((item) => item.path),
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

    const targetOutputs = selectedOutputs.length > 0 ? selectedOutputs : outputs
    const text = targetOutputs.map((item) => item.path).join('\n')
    try {
      await navigator.clipboard.writeText(text)
      setStatusText(
        selectedOutputs.length > 0
          ? `已复制 ${selectedOutputs.length} 个选中结果的路径`
          : '已复制全部结果路径',
      )
    } catch {
      setStatusText('复制失败，请检查系统剪贴板权限')
    }
  }

  const copySingleOutputImage = async (item: OutputItem) => {
    if (item.kind !== 'image') {
      return false
    }

    const sourceDataUrl = fullPreviewSrcMap[item.id] || previewSrcMap[item.id]
    const imageDataUrl = sourceDataUrl || (await invokeBackend<string>('load_preview_data', { path: item.path }))

    if (typeof navigator.clipboard?.write !== 'function' || typeof ClipboardItem === 'undefined') {
      setStatusText('当前环境不支持直接复制图片到剪贴板')
      return true
    }

    try {
      const blob = await dataUrlToBlob(imageDataUrl)
      await navigator.clipboard.write([
        new ClipboardItem({
          [blob.type || 'image/png']: blob,
        }),
      ])
      setFullPreviewSrcMap((current) => ({ ...current, [item.id]: imageDataUrl }))
      setStatusText(`已复制图片：${item.label}`)
      return true
    } catch {
      setStatusText('复制图片失败，请检查系统剪贴板权限')
      return true
    }
  }

  const copyPreviewImage = async () => {
    if (!previewingOutput) {
      setStatusText('当前没有正在预览的结果')
      return
    }

    if (previewingOutput.kind !== 'image') {
      setStatusText('当前结果不是图片，暂时不能直接复制图片本体')
      return
    }
    await copySingleOutputImage(previewingOutput)
  }

  const clearResults = async () => {
    setOutputs([])
    setSelectedOutputIds([])
    lastSelectedOutputIdRef.current = null
    setPreviewSrcMap({})
    setFullPreviewSrcMap({})
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
    if (selectedOutputs.length === 0) {
      setStatusText('先点选要移除的结果')
      return
    }

    const selectedIds = selectedOutputs.map((item) => item.id)
    const nextOutputs = outputs.filter((item) => !selectedIds.includes(item.id))
    setOutputs(nextOutputs)
    setSelectedOutputIds([])
    lastSelectedOutputIdRef.current = null
    setPreviewSrcMap((current) =>
      Object.fromEntries(Object.entries(current).filter(([id]) => !selectedIds.includes(id))),
    )
    setFullPreviewSrcMap((current) =>
      Object.fromEntries(Object.entries(current).filter(([id]) => !selectedIds.includes(id))),
    )
    setStatusText(`已从缓冲区移除 ${selectedIds.length} 个结果`)
  }

  const openOutputPreview = (item: OutputItem) => {
    setPreviewingOutput(item)
    setPreviewScale(1)
    setPreviewScaleDraft(100)
    setPreviewOffset({ x: 0, y: 0 })
  }

  const handleOutputSelect = (
    event: React.MouseEvent<HTMLButtonElement>,
    item: OutputItem,
    index: number,
  ) => {
    if (event.shiftKey && lastSelectedOutputIdRef.current) {
      const anchorIndex = outputCards.findIndex((entry) => entry.id === lastSelectedOutputIdRef.current)
      if (anchorIndex >= 0) {
        const start = Math.min(anchorIndex, index)
        const end = Math.max(anchorIndex, index)
        setSelectedOutputIds(outputCards.slice(start, end + 1).map((entry) => entry.id))
        return
      }
    }

    if (event.metaKey || event.ctrlKey) {
      setSelectedOutputIds((current) =>
        current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id],
      )
      lastSelectedOutputIdRef.current = item.id
      return
    }

    setSelectedOutputIds([item.id])
    lastSelectedOutputIdRef.current = item.id
  }

  const handleOutputGridPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) {
      return
    }

    const container = outputGridRef.current
    if (!container) {
      return
    }

    const rect = container.getBoundingClientRect()
    const originX = event.clientX - rect.left
    const originY = event.clientY - rect.top
    const additive = event.metaKey || event.ctrlKey
    const baseIds = additive ? selectedOutputIds : []

    selectionDragRef.current = {
      active: true,
      pointerId: event.pointerId,
      originX,
      originY,
      additive,
      baseIds,
      dragged: false,
    }

    setSelectionBox({
      active: true,
      x: originX,
      y: originY,
      width: 0,
      height: 0,
    })

    if (!additive) {
      setSelectedOutputIds([])
      lastSelectedOutputIdRef.current = null
    }

    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handleOutputGridPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!selectionDragRef.current.active) {
      return
    }

    const container = outputGridRef.current
    if (!container) {
      return
    }

    const rect = container.getBoundingClientRect()
    const currentX = Math.min(Math.max(0, event.clientX - rect.left), rect.width)
    const currentY = Math.min(Math.max(0, event.clientY - rect.top), rect.height)
    const nextBox = {
      active: true,
      x: Math.min(selectionDragRef.current.originX, currentX),
      y: Math.min(selectionDragRef.current.originY, currentY),
      width: Math.abs(currentX - selectionDragRef.current.originX),
      height: Math.abs(currentY - selectionDragRef.current.originY),
    }

    if (nextBox.width > 4 || nextBox.height > 4) {
      selectionDragRef.current.dragged = true
    }

    setSelectionBox(nextBox)
    selectOutputsInBox(
      nextBox,
      selectionDragRef.current.baseIds,
      selectionDragRef.current.additive,
    )
  }

  const finishOutputGridSelection = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!selectionDragRef.current.active) {
      return
    }

    if (selectionDragRef.current.dragged) {
      event.preventDefault()
      event.stopPropagation()
    }

    selectionDragRef.current.active = false
    selectionDragRef.current.pointerId = null
    setSelectionBox(null)

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (previewingOutput || isEditableTarget(event.target)) {
        return
      }

      const key = event.key.toLowerCase()

      if ((event.metaKey || event.ctrlKey) && key === 'a' && outputs.length > 0) {
        event.preventDefault()
        setSelectedOutputIds(outputs.map((item) => item.id))
        lastSelectedOutputIdRef.current = outputs[outputs.length - 1]?.id ?? null
        return
      }

      if ((event.metaKey || event.ctrlKey) && key === 'c' && selectedOutputCount > 0) {
        event.preventDefault()
        if (selectedOutputs.length === 0) {
          setStatusText('先选中要复制的结果')
          return
        }

        if (selectedOutputs.length === 1 && isPrimaryImageOutput(selectedOutputs[0])) {
          const selectedItem = selectedOutputs[0]
          void invokeBackend<void>('copy_image_to_clipboard', { path: selectedItem.path })
            .then(() => setStatusText(`已复制图片：${selectedItem.label}`))
            .catch((error) => setStatusText(getErrorMessage(error, '复制图片失败')))
          return
        }

        void invokeBackend<void>('copy_files_to_clipboard', {
          paths: selectedOutputs.map((item) => item.path),
        })
          .then(() => setStatusText(`已复制 ${selectedOutputs.length} 个文件`))
          .catch(async (error) => {
            const text = selectedOutputs.map((item) => item.path).join('\n')
            try {
              await navigator.clipboard.writeText(text)
              setStatusText(`已复制 ${selectedOutputs.length} 个结果路径`)
            } catch {
              setStatusText(getErrorMessage(error, '复制失败，请检查系统剪贴板权限'))
            }
          })
        return
      }

      if (event.code === 'Space' && selectedOutputCount > 0) {
        event.preventDefault()
        const activeSelection =
          selectedOutputs.find((item) => item.id === lastSelectedOutputIdRef.current) ?? selectedOutputs[0]
        if (!activeSelection || activeSelection.kind !== 'image') {
          setStatusText('空格预览只支持图片结果，PDF 可以导出后用系统应用查看。')
          return
        }
        setPreviewingOutput(activeSelection)
        setPreviewScale(1)
        setPreviewScaleDraft(100)
        setPreviewOffset({ x: 0, y: 0 })
        return
      }

      if ((event.key === 'Backspace' || event.key === 'Delete') && selectedOutputCount > 0) {
        event.preventDefault()
        const selectedIds = selectedOutputs.map((item) => item.id)
        const nextOutputs = outputs.filter((item) => !selectedIds.includes(item.id))
        setOutputs(nextOutputs)
        setSelectedOutputIds([])
        lastSelectedOutputIdRef.current = null
        setPreviewSrcMap((current) =>
          Object.fromEntries(Object.entries(current).filter(([id]) => !selectedIds.includes(id))),
        )
        setStatusText(`已从缓冲区移除 ${selectedIds.length} 个结果`)
        return
      }

      if (event.key === 'Escape' && selectedOutputCount > 0) {
        setSelectedOutputIds([])
        lastSelectedOutputIdRef.current = null
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [outputs, previewingOutput, selectedOutputCount, selectedOutputs])

  const handlePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    snapAnimationRef.current?.forEach((controls) => controls.stop())
    snapAnimationRef.current = null

    const layer = launcherLayerRef.current
    const bounds = layer?.getBoundingClientRect() ?? event.currentTarget.getBoundingClientRect()
    dragRef.current = {
      active: true,
      moved: false,
      x: anchor.x,
      y: anchor.y,
      pointerOffsetX: event.clientX - bounds.left,
      pointerOffsetY: event.clientY - bounds.top,
      width: bounds.width,
      height: bounds.height,
    }

    event.currentTarget.setPointerCapture(event.pointerId)
    setIsLauncherDragging(true)
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
    const clampedX = Math.min(Math.max(margin, nextX), maxX)
    const clampedY = Math.min(Math.max(margin, nextY), maxY)

    if (Math.abs(clampedX - anchor.x) > 3 || Math.abs(clampedY - anchor.y) > 3) {
      dragRef.current.moved = true
    }

    dragRef.current.x = clampedX
    dragRef.current.y = clampedY

    if (launcherLayerRef.current) {
      launcherLayerRef.current.style.left = `${clampedX}px`
      launcherLayerRef.current.style.top = `${clampedY}px`
    }
  }

  const handlePointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    if (!dragRef.current.active) {
      return
    }

    dragRef.current.active = false
    setIsLauncherDragging(false)
    event.currentTarget.releasePointerCapture(event.pointerId)
    const currentX = dragRef.current.x
    const currentY = dragRef.current.y
    const snapped = snapToNearestCorner(currentX, currentY)
    const layer = launcherLayerRef.current
    let latestX = currentX
    let latestY = currentY

    const syncFinalAnchor = () => {
      if (Math.abs(latestX - snapped.x) < 0.5 && Math.abs(latestY - snapped.y) < 0.5) {
        setAnchor(snapped)
        snapAnimationRef.current = null
      }
    }

    const xAnimation = animate(currentX, snapped.x, {
      type: 'spring',
      stiffness: 520,
      damping: 38,
      mass: 0.72,
      onUpdate: (value) => {
        latestX = value
        if (layer) {
          layer.style.left = `${value}px`
        }
      },
      onComplete: syncFinalAnchor,
    })

    const yAnimation = animate(currentY, snapped.y, {
      type: 'spring',
      stiffness: 520,
      damping: 38,
      mass: 0.72,
      onUpdate: (value) => {
        latestY = value
        if (layer) {
          layer.style.top = `${value}px`
        }
      },
      onComplete: syncFinalAnchor,
    })

    snapAnimationRef.current = [xAnimation, yAnimation]
  }

  const handlePointerCancel = () => {
    snapAnimationRef.current?.forEach((controls) => controls.stop())
    snapAnimationRef.current = null
    dragRef.current.active = false
    setIsLauncherDragging(false)
  }

  return (
    <main className="app-shell">
      <div className="ambient ambient-left" />
      <div className="ambient ambient-right" />

      <section className={`workspace-card ${activeTool === 'text-compare' ? 'workspace-card-compact' : ''}`}>
        {activeTool !== 'text-compare' && (
          <header className="workspace-banner">
            <div>
              <p className="section-kicker">工作区</p>
              <div className="title-row">
                <h2>{currentTool.title}</h2>
                <span className="version-badge">v{appVersion}</span>
              </div>
              <p>{currentTool.subtitle}</p>
            </div>
            <div className="status-badge">{statusText}</div>
          </header>
        )}

        <AnimatePresence mode="wait">
          <motion.div
            key={activeTool}
            className="tool-page-shell"
            initial={{ opacity: 0, scale: 0.988, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.992, y: -10 }}
            transition={{ duration: 0.34, ease: [0.22, 0.72, 0.18, 1] }}
          >
        {activeTool === 'text-compare' ? (
          <section className="compare-workspace">
	            <div className="compare-toolbar">
		              <div className="compare-title-row">
		                <strong className="compare-mini-title">文本对比</strong>
		                <span className="version-badge">v{appVersion}</span>
		              </div>
	              <div className="compare-summary">
	                <span>修改 {diffSummary.changed}</span>
	                <span>新增 {diffSummary.added}</span>
	                <span>删除 {diffSummary.removed}</span>
	              </div>
	              <button
                type="button"
                className="clear-compare-button"
                onClick={() => {
                  setLeftCompareText('')
                  setRightCompareText('')
                  if (leftCompareRef.current) {
                    leftCompareRef.current.scrollTop = 0
                    leftCompareRef.current.scrollLeft = 0
                  }
                  if (rightCompareRef.current) {
                    rightCompareRef.current.scrollTop = 0
                    rightCompareRef.current.scrollLeft = 0
                  }
                  if (leftCompareLayerRef.current) {
                    leftCompareLayerRef.current.style.transform = 'translate(0, 0)'
                  }
                  if (rightCompareLayerRef.current) {
                    rightCompareLayerRef.current.style.transform = 'translate(0, 0)'
                  }
                }}
              >
                清屏
              </button>
            </div>

            <div className="compare-diff-shell">
              <div className="compare-editor-panel">
                <div className="compare-editor-head">
                  <strong>输入内容</strong>
                  <span>{leftCompareText.length} 字符</span>
                </div>
                <div className="compare-editor-shell">
                  <div ref={leftCompareLayerRef} className="compare-diff-layer" aria-hidden>
                    {diffLines.map((line, index) => (
                      <div
                        key={`left-layer-${index}-${line.kind}`}
                        className={`compare-line compare-line-${line.kind} ${line.leftChanged ? 'is-changed' : ''}`}
                      >
                        <span className="compare-line-number">{index + 1}</span>
                        <code>{line.left || ' '}</code>
                      </div>
                    ))}
                  </div>
	                  <textarea
	                    ref={leftCompareRef}
	                    className="compare-editor"
	                    value={leftCompareText}
	                    onScroll={() => syncCompareScroll('left')}
	                    onWheel={(event) => handleCompareWheel('left', event)}
	                    onChange={(event) => setLeftCompareText(event.target.value)}
                    placeholder="输入内容"
                    spellCheck={false}
                    wrap="off"
                  />
                </div>
              </div>

              <div className="compare-editor-panel">
                <div className="compare-editor-head">
                  <strong>输入内容</strong>
                  <span>{rightCompareText.length} 字符</span>
                </div>
                <div className="compare-editor-shell">
                  <div ref={rightCompareLayerRef} className="compare-diff-layer" aria-hidden>
                    {diffLines.map((line, index) => (
                      <div
                        key={`right-layer-${index}-${line.kind}`}
                        className={`compare-line compare-line-${line.kind} ${line.rightChanged ? 'is-changed' : ''}`}
                      >
                        <span className="compare-line-number">{index + 1}</span>
                        <code>{line.right || ' '}</code>
                      </div>
                    ))}
                  </div>
	                  <textarea
	                    ref={rightCompareRef}
	                    className="compare-editor"
	                    value={rightCompareText}
	                    onScroll={() => syncCompareScroll('right')}
	                    onWheel={(event) => handleCompareWheel('right', event)}
	                    onChange={(event) => setRightCompareText(event.target.value)}
                    placeholder="输入内容"
                    spellCheck={false}
                    wrap="off"
                  />
                </div>
              </div>
            </div>
          </section>
        ) : (
        <div className="workspace-grid">
          <aside className="pane pane-source">
            <div className="pane-head">
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
	                    className="source-item"
	                  >
	                    <span className={`type-pill type-${item.kind}`}>
	                      {item.kind === 'pdf' ? 'PDF' : 'IMG'}
	                    </span>
	                    <div className="source-copy">
	                      <strong>{item.name}</strong>
	                      <p>{item.kind === 'image' ? '用右侧上移 / 下移调整合并顺序' : item.detail}</p>
	                    </div>
		                    {item.kind === 'image' && (
		                      <div className="source-order-actions" aria-label={`${item.name} 排序操作`}>
		                        <button
		                          type="button"
		                          className="source-order-button"
		                          disabled={index === 0}
		                          onClick={() => moveSource(item.id, -1)}
		                        >
		                          上移
		                        </button>
		                        <button
		                          type="button"
		                          className="source-order-button"
		                          disabled={index === sources.length - 1}
		                          onClick={() => moveSource(item.id, 1)}
		                        >
		                          下移
		                        </button>
		                      </div>
		                    )}
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
                <p>导入后会直接出现在这个区域，图片可用上移 / 下移调整顺序，合成 PDF 时会按这里的顺序输出。</p>
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
                  className={`tool-action-button ${hasPdfSources && !isBusy ? 'is-ready' : ''}`}
                  disabled={isBusy || !hasPdfSources}
                  onClick={() => runAction('pdf-to-images')}
                >
                  PDF 转图片
                </button>
                <button
                  type="button"
                  className={`tool-action-button ${hasImageSources && !isBusy ? 'is-ready' : ''}`}
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

	            </div>
          </aside>

          <section className="pane pane-output">
            <div className="pane-head">
              <span>{selectedOutputCount > 0 ? `已选 ${selectedOutputCount} 项` : `${outputs.length} 个结果`}</span>
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

            <div
              ref={outputGridRef}
              className={`output-grid output-grid-${outputViewMode}`}
              onPointerDown={handleOutputGridPointerDown}
              onPointerMove={handleOutputGridPointerMove}
              onPointerUp={finishOutputGridSelection}
              onPointerCancel={finishOutputGridSelection}
              onClick={(event) => {
                if (selectionDragRef.current.dragged) {
                  selectionDragRef.current.dragged = false
                  return
                }

                if (event.target === event.currentTarget) {
                  setSelectedOutputIds([])
                  lastSelectedOutputIdRef.current = null
                }
              }}
            >
              {outputCards.map((item, index) => (
                <article
                  key={item.id}
                  className={`output-card output-card-${outputViewMode} ${selectedOutputSet.has(item.id) ? 'is-selected' : ''}`}
                  ref={(node) => {
                    outputCardRefs.current[item.id] = node
                  }}
                >
                  <button
                    type="button"
                    className="preview-button"
                    onClick={(event) => handleOutputSelect(event, item, index)}
                    onDoubleClick={() => openOutputPreview(item)}
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
                  </div>
                </article>
              ))}
              {selectionBox && (
                <div
                  className="selection-box"
                  style={{
                    left: selectionBox.x,
                    top: selectionBox.y,
                    width: selectionBox.width,
                    height: selectionBox.height,
                  }}
                />
              )}
            </div>
          </section>
        </div>
        )}
          </motion.div>
        </AnimatePresence>
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
                      setPreviewScaleDraft(100)
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
                      setPreviewScaleDraft(100)
                      setPreviewOffset({ x: 0, y: 0 })
                    }
                  }}
                >
                  下一张
                </button>
                <button
                  type="button"
                  className="ghost-button compact-button"
                  disabled={previewingOutput.kind !== 'image'}
                  onClick={copyPreviewImage}
                >
                  复制图片
                </button>
                <label className="zoom-slider">
                  <span>{previewScaleDraft}%</span>
                  <input
                    type="range"
                    min="50"
                    max="200"
                    step="5"
                    value={previewScaleDraft}
                    onChange={(event) => {
                      setPreviewScaleDraft(Number(event.target.value))
                    }}
                    onPointerUp={() => {
                      const nextScale = previewScaleDraft / 100
                      setPreviewScale(nextScale)
                      setPreviewOffset((current) => clampPreviewOffset(current.x, current.y, nextScale))
                    }}
                    onPointerCancel={() => {
                      const nextScale = previewScaleDraft / 100
                      setPreviewScale(nextScale)
                      setPreviewOffset((current) => clampPreviewOffset(current.x, current.y, nextScale))
                    }}
                  />
                </label>
                <span className="lightbox-counter">
                  {previewingIndex >= 0 ? `${previewingIndex + 1} / ${outputCards.length}` : `0 / ${outputCards.length}`}
                </span>
                <button
                  type="button"
                  className="ghost-button compact-button"
                  onClick={() => {
                    setPreviewingOutput(null)
                    setPreviewScale(1)
                    setPreviewScaleDraft(100)
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
                event.stopPropagation()
                const nextScale = Math.min(
                  2,
                  Math.max(0.5, Number((previewScale + (event.deltaY < 0 ? 0.08 : -0.08)).toFixed(2))),
                )
                setPreviewScale(nextScale)
                setPreviewScaleDraft(Math.round(nextScale * 100))
                setPreviewOffset((current) => clampPreviewOffset(current.x, current.y, nextScale))
              }}
            >
              {previewDisplaySrc ? (
                <img
                  ref={lightboxImageRef}
                  className="lightbox-image"
                  src={previewDisplaySrc}
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
              const offset = (launcherSize + launcherGap - 6) * (index + 1)
              const x = 0
              const y = stackDirection === 'up' ? -offset : offset
              const expanded = hoveredTool === tool.id

              return (
                <motion.button
                  key={tool.id}
                  type="button"
                  className={`tool-orb ${expanded ? 'is-expanded' : ''}`}
                  layout
                  initial={{ opacity: 0, scale: 0.92, x: 0, y: 0, rotate: stackDirection === 'up' ? -6 : 6 }}
                  animate={{
                    opacity: 1,
                    scale: expanded ? 1.08 : 1,
                    x,
                    y,
                    rotate: expanded ? 0 : stackDirection === 'up' ? -2 : 2,
                  }}
                  exit={{ opacity: 0, scale: 0.92, x: 0, y: 0, rotate: stackDirection === 'up' ? -6 : 6 }}
                  transition={{
                    layout: { type: 'spring', stiffness: 500, damping: 34, mass: 0.7 },
                    default: { type: 'spring', stiffness: 430, damping: 30, mass: 0.72, delay: index * 0.02 },
                  }}
                  style={{ backgroundImage: tool.color }}
                  onMouseEnter={() => setHoveredTool(tool.id)}
                  onMouseLeave={() => setHoveredTool(null)}
                  onClick={(event) => triggerToolSwitch(tool, event)}
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
          layout
          style={{ backgroundImage: currentTool.color }}
          animate={
            isLauncherDragging
              ? { scale: 1, rotate: 0 }
              : { scale: menuOpen ? 1.03 : 1, rotate: menuOpen ? 3 : 0 }
          }
          transition={{ type: 'spring', stiffness: 460, damping: 32, mass: 0.72 }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
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

      <AnimatePresence>
        {toolTransition && (
          <motion.div
            key={toolTransition.id}
            className="tool-transition-layer"
            initial={{ opacity: 1 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.28, ease: 'easeOut' } }}
          >
            <motion.div
              className="tool-transition-orb"
              initial={{
                x: toolTransition.startX - launcherSize / 2,
                y: toolTransition.startY - launcherSize / 2,
                scale: 0.92,
                opacity: 1,
              }}
              animate={{
                x: [
                  toolTransition.startX - launcherSize / 2,
                  toolTransition.targetX - launcherSize / 2,
                  toolTransition.targetX - launcherSize / 2,
                ],
                y: [
                  toolTransition.startY - launcherSize / 2,
                  toolTransition.targetY - launcherSize / 2,
                  toolTransition.targetY - launcherSize / 2,
                ],
                scale: [0.92, 1.06, 0.72],
                opacity: [1, 1, 0],
              }}
              transition={{
                duration: 0.54,
                times: [0, 0.78, 1],
                ease: [0.2, 0.88, 0.18, 1],
              }}
              style={{ backgroundImage: toolTransition.tool.color }}
            >
              <span>{toolTransition.tool.icon}</span>
            </motion.div>
            <motion.div
              className="tool-transition-pulse"
              initial={{
                x: toolTransition.targetX - launcherSize / 2,
                y: toolTransition.targetY - launcherSize / 2,
                scale: 0.72,
                opacity: 0,
              }}
              animate={{ scale: [0.72, 1.28, 1.64], opacity: [0, 0.22, 0] }}
              transition={{ duration: 0.38, delay: 0.4, ease: [0.22, 0.72, 0.18, 1] }}
              style={{ backgroundImage: toolTransition.tool.color }}
            />
            <motion.div
              className="tool-transition-wipe"
              initial={{
                x: toolTransition.targetX - launcherSize / 2,
                y: toolTransition.targetY - launcherSize / 2,
                width: launcherSize,
                height: launcherSize,
                borderRadius: launcherSize,
                opacity: 0,
              }}
              animate={{
                x: [
                  toolTransition.targetX - launcherSize / 2,
                  toolTransition.targetX - toolTransition.radius,
                  toolTransition.targetX - toolTransition.radius,
                ],
                y: [
                  toolTransition.targetY - launcherSize / 2,
                  toolTransition.targetY - toolTransition.radius,
                  toolTransition.targetY - toolTransition.radius,
                ],
                width: [launcherSize, toolTransition.radius * 2, toolTransition.radius * 2],
                height: [launcherSize, toolTransition.radius * 2, toolTransition.radius * 2],
                borderRadius: [launcherSize, toolTransition.radius, toolTransition.radius],
                opacity: [0, 0.96, 0],
              }}
              transition={{ duration: 0.84, delay: 0.4, times: [0, 0.64, 1], ease: [0.18, 0.74, 0.2, 1] }}
              style={{ backgroundImage: toolTransition.tool.color }}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  )
}

export default App
