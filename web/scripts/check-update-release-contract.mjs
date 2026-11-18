import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const text = readFileSync(new URL('../../.github/workflows/electron-release.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

// 发布入口：手动 dispatch，或推送 v* 标签。
assert.match(text, /^  workflow_dispatch:/m)
const tagPush = /^  push:\n    tags:\n      - 'v\*'$/m
assert.match(text, tagPush)

// 版本号只认 electron/package.json；标签必须与该版本一致，且在构建前完成校验。
const versionSource = text.indexOf('electron/package.json')
const versionGuard = text.indexOf('Tag $tag does not match electron/package.json version $version.')
const buildStep = text.indexOf('Build host and NSIS installer')
assert.ok(versionSource >= 0 && versionGuard > versionSource, '发布版本号必须取自 electron/package.json')
assert.ok(buildStep > versionGuard, '版本一致性校验必须在构建前完成')

// 构建与产物命名：esbuild 打包宿主，electron-builder 只打 NSIS，不自动 publish。
assert.ok(text.indexOf('node scripts/build.mjs') < text.indexOf('node node_modules/electron-builder/cli.js'))
assert.match(text, /--win nsis --publish never/)
assert.match(text, /Denia-\$tag-windows-x64-setup\.exe/)
assert.match(text, /SHA256SUMS\.txt/)

console.log('Electron release contract: tag/version guard runs before the NSIS build and the installer name is stable.')