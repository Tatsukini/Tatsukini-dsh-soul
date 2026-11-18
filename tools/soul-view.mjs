// Soul dashboard bridge — run by hand with any Node runtime: `node tools/soul-view.mjs`.
// Regenerates <home>/soul/dashboard.html using the plugin's OWN curve math + template (single
// source of truth), then prints the absolute path so a launcher or browser can open it.
// No DSH app required. Resolves the plugin next to this script by default; override with
// SOUL_PLUGIN (path to index.js) and the DSH home with DSH_HOME.
import { pathToFileURL } from 'node:url'

const PLUGIN_URL = process.env.SOUL_PLUGIN
  ? pathToFileURL(process.env.SOUL_PLUGIN).href
  : new URL('../index.js', import.meta.url).href

try {
  const soul = await import(PLUGIN_URL)
  if (typeof soul.view !== 'function') throw new Error('插件没有导出 view(): ' + PLUGIN_URL)
  const { dir, dashboard } = soul.view(process.env.DSH_HOME)
  process.stdout.write(dashboard)
  process.stderr.write(`[soul-view] 记忆目录 ${dir}\n[soul-view] 可视化已生成 ${dashboard}\n`)
} catch (e) {
  process.stderr.write('[soul-view] 生成失败: ' + (e && e.stack ? e.stack : String(e)) + '\n')
  process.exitCode = 1
}
