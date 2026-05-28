import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const explicitVersion = process.argv[2]?.trim()
const rawTag = process.env.GITHUB_REF_NAME?.trim() || process.env.TAG_NAME?.trim() || ''
const detectedVersion = explicitVersion || rawTag.replace(/^v/, '')

if (!detectedVersion) {
  console.error('缺少版本号。请传入参数或提供 GITHUB_REF_NAME / TAG_NAME。')
  process.exit(1)
}

if (!/^\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$/.test(detectedVersion)) {
  console.error(`版本号格式无效：${detectedVersion}`)
  process.exit(1)
}

const packageJsonPath = join(root, 'package.json')
const tauriConfigPath = join(root, 'src-tauri', 'tauri.conf.json')
const cargoTomlPath = join(root, 'src-tauri', 'Cargo.toml')

const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
packageJson.version = detectedVersion
writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`)

const tauriConfig = JSON.parse(readFileSync(tauriConfigPath, 'utf8'))
tauriConfig.version = detectedVersion
writeFileSync(tauriConfigPath, `${JSON.stringify(tauriConfig, null, 2)}\n`)

const cargoToml = readFileSync(cargoTomlPath, 'utf8').replace(
  /^version = ".*"$/m,
  `version = "${detectedVersion}"`,
)
writeFileSync(cargoTomlPath, cargoToml)

console.log(`Synchronized version to ${detectedVersion}`)
