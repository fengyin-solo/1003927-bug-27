// 用 esbuild 即时打包核验脚本（解析 @/ 别名），产物落到临时目录后用 Node 执行。
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const outDir = fileURLToPath(new URL('../.verify/', import.meta.url))
const outfile = `${outDir}verify-alarm.mjs`

await build({
  entryPoints: [fileURLToPath(new URL('../scripts/verify-alarm.ts', import.meta.url))],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  alias: { '@': fileURLToPath(new URL('../src/', import.meta.url)) },
  logLevel: 'warning',
})

try {
  execFileSync(process.execPath, [outfile], { stdio: 'inherit' })
} finally {
  rmSync(outDir, { recursive: true, force: true })
}
