// Verifies the auto-act (想起就去做) branch: in the default mode, a ripe loop on idle fires a
// continuation whose nudge tells the keeper to CARRY IT OUT now (not merely ask), while still
// carving out the irreversible/external/spending actions. Balance guard + ask-mode forced off/on
// for determinism; a single fire so the cooldown/seen-set never get in the way.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

process.env.SOUL_BALANCE_GUARD = '0' // don't hit the network; we are testing the nudge text, not the floor
// SOUL_AUTO_ACT left unset -> DEFAULT_PREFS.autoAct = true -> act mode.

const soul = await import(new URL('../index.js', import.meta.url).href)

const home = mkdtempSync(join(tmpdir(), 'soul-act-'))
const listeners = {}
const ctx = {
  profileContext: { home },
  effect: (fn) => { fn(); return () => {} },
  systemPrompt: { context: () => () => {}, section: () => () => {} },
  tools: { register: () => {} },
  on: (name, cb) => { listeners[name] = cb; return () => true },
}
const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1 } else { console.log('  ok:', msg) } }
const tick = () => new Promise((r) => setTimeout(r, 15))
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10)

soul.apply(ctx)

const created = iso(95)
writeFileSync(join(home, 'soul', 'loops.md'),
  '# 你记挂着的事\n' + `- [${created}] 帮我把桌面截图按月份归档 <!--c=${created} r=${created} n=1 k=loop-->\n`, 'utf8')

const fired = []
listeners['agent/status']({ agent: { followup: (m) => fired.push(m) }, status: 'idle' })
await tick()

console.log('--- act mode fires and carries the loop out ---')
assert(fired.length === 1, 'ripe loop -> one continuation fired')
const text = fired[0] && fired[0].content && fired[0].content[0].text || ''
assert(/把它做掉/.test(text), 'nudge tells the keeper to DO it, not just ask')
assert(/soul_close_loop/.test(text) && /soul_touch/.test(text), 'nudge closes + reinforces the memory on completion')
assert(/花钱、对外发送、删除、越出工作区、或不可逆/.test(text), 'nudge still carves out irreversible/external actions')
assert(/桌面截图按月份归档/.test(text), 'nudge references the remembered loop text')

rmSync(home, { recursive: true, force: true })
console.log('\nRESULT:', process.exitCode === 1 ? 'HAS FAILURES' : 'ALL PASS')
