#!/usr/bin/env node
/**
 * 预警通知数据层冒烟测试运行器（不依赖 esbuild / vitest，只需 typescript）。
 * 用 tsc 把 store 与测试编译成 CJS 到临时目录，修正扩展名后用 node 运行。
 */
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const frontendDir = path.resolve(__dirname, '..', 'frontend')
const repoRoot = path.resolve(__dirname, '..')
const outDir = path.join(frontendDir, '.smoke-build')

fs.rmSync(outDir, { recursive: true, force: true })

const tsc = path.join(frontendDir, 'node_modules', 'typescript', 'bin', 'tsc')
const tests = ['alarm.smoke.ts', 'alarm.migration.ts'].map((f) => path.join(__dirname, f))
const sources = ['store.ts', 'seed.ts', 'types.ts'].map((f) =>
  path.join(frontendDir, 'src', 'data', 'alarm', f),
)

execFileSync(
  process.execPath,
  [
    tsc,
    '--module', 'commonjs',
    '--target', 'ES2020',
    '--moduleResolution', 'node',
    '--esModuleInterop',
    '--skipLibCheck',
    '--outDir', outDir,
    '--rootDir', repoRoot,
    ...tests,
    ...sources,
  ],
  { stdio: 'inherit', cwd: frontendDir },
)

function walk(dir) {
  const entries = []
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    if (fs.statSync(full).isDirectory()) {
      entries.push(...walk(full))
    } else if (full.endsWith('.js')) {
      entries.push(full)
    }
  }
  return entries
}

for (const file of walk(outDir)) {
  const cjs = file.replace(/\.js$/, '.cjs')
  fs.renameSync(file, cjs)
  let content = fs.readFileSync(cjs, 'utf8')
  content = content
    .replaceAll('require("./seed")', 'require("./seed.cjs")')
    .replaceAll('require("./types")', 'require("./types.cjs")')
    .replaceAll("require('../frontend/src/data/alarm/store')", "require('../frontend/src/data/alarm/store.cjs')")
    .replaceAll('require("../frontend/src/data/alarm/store")', 'require("../frontend/src/data/alarm/store.cjs")')
  fs.writeFileSync(cjs, content)
}

let failed = 0
for (const name of ['alarm.smoke.cjs', 'alarm.migration.cjs']) {
  console.log(`\n=== ${name} ===`)
  try {
    execFileSync(process.execPath, [path.join(outDir, 'tests', name)], { stdio: 'inherit' })
  } catch {
    failed += 1
  }
}

fs.rmSync(outDir, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
