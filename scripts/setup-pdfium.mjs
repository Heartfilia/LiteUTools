import { mkdirSync, existsSync, createWriteStream, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { execFileSync } from 'node:child_process'

const root = process.cwd()
const checkOnly = process.argv.includes('--check')
const targets = [
  {
    name: 'macOS',
    url: 'https://github.com/bblanchon/pdfium-binaries/releases/latest/download/pdfium-mac-univ.tgz',
    archiveName: 'pdfium-mac-univ.tgz',
    extractFile: 'lib/libpdfium.dylib',
    outputDir: join(root, 'resources', 'pdfium', 'macos'),
    outputFile: 'libpdfium.dylib',
  },
  {
    name: 'Windows',
    url: 'https://github.com/bblanchon/pdfium-binaries/releases/latest/download/pdfium-win-x64.tgz',
    archiveName: 'pdfium-win-x64.tgz',
    extractFile: 'bin/pdfium.dll',
    outputDir: join(root, 'resources', 'pdfium', 'windows'),
    outputFile: 'pdfium.dll',
  },
]

async function download(url, destination) {
  const response = await fetch(url)
  if (!response.ok || !response.body) {
    throw new Error(`下载失败: ${url} -> ${response.status}`)
  }

  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination))
}

async function ensureTarget(target) {
  const extractedPath = join(target.outputDir, target.outputFile)
  if (existsSync(extractedPath)) {
    console.log(`Found ${target.name} Pdfium at ${extractedPath}`)
    return
  }

  if (checkOnly) {
    throw new Error(`缺少 ${target.name} Pdfium：${extractedPath}`)
  }

  const archivePath = join(tmpdir(), `${Date.now()}-${target.archiveName}`)
  mkdirSync(target.outputDir, { recursive: true })

  console.log(`Downloading ${target.name} Pdfium...`)
  await download(target.url, archivePath)

  console.log(`Extracting ${target.outputFile}...`)
  execFileSync(
    'tar',
    [
      '-xzf',
      archivePath,
      '-C',
      target.outputDir,
      '--strip-components',
      String(target.extractFile.split('/').length - 1),
      target.extractFile,
    ],
    { stdio: 'inherit' },
  )

  if (!existsSync(extractedPath)) {
    throw new Error(`${target.name} Pdfium 解压失败`)
  }

  unlinkSync(archivePath)
  console.log(`Saved to ${extractedPath}`)
}

async function main() {
  for (const target of targets) {
    await ensureTarget(target)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
