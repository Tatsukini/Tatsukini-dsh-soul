import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as soul from '../index.js'

const home = mkdtempSync(join(tmpdir(), 'soul-test-'))
const tools = {}
const contexts = {}
const sections = {}
let effectDisposers = []

const ctx = {
  profileContext: { home },
  effect: (fn) => { const d = fn(); if (typeof d === 'function') effectDisposers.push(d) },
  systemPrompt: {
    context: (def) => { contexts[def.name] = def; return () => {} },
    section: (def) => { sections[def.name] = def; return () => {} },
  },
  tools: { register: (t) => { tools[t.name] = t } },
}

const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1 } else { console.log('  ok:', msg) } }

console.log('--- apply() ---')
soul.apply(ctx)
assert(soul.name === 'soul', 'export name = soul')
assert(soul.inject.includes('systemPrompt') && soul.inject.includes('tools'), 'inject lists tools+systemPrompt')
assert(!!contexts['soul:recall'], 'recall context registered')
assert(!!sections['soul:guidance'], 'guidance section registered')
assert(Object.keys(tools).sort().join(',') === 'soul_close_loop,soul_dashboard,soul_forget,soul_list,soul_remember,soul_touch,soul_urge,soul_write', 'eight tools registered: ' + Object.keys(tools))

console.log('--- empty store renders no recall ---')
assert(contexts['soul:recall'].text() === '', 'recall is "" before any memory')

console.log('--- soul_remember fact + loop ---')
const r1 = await tools['soul_remember'].execute({ content: '他的生日是 3 月 7 日', kind: undefined })
assert(r1.ok && r1.kind === 'fact' && r1.items === 1, 'remember fact -> items 1, no undefined in result: ' + JSON.stringify(r1))
const r2 = await tools['soul_remember'].execute({ content: '他提过想整理桌面截图归档', kind: 'loop' })
assert(r2.kind === 'loop' && r2.items === 1, 'remember loop -> items 1')
assert(existsSync(join(home, 'soul', 'facts.md')), 'facts.md created')
assert(existsSync(join(home, 'soul', 'loops.md')), 'loops.md created')

console.log('--- recall now surfaces both ---')
const rec = contexts['soul:recall'].text()
assert(/生日是 3 月 7 日/.test(rec) && /桌面截图归档/.test(rec) && rec.includes('风格') === false, 'recall contains fact + loop')

console.log('--- cross-session persistence (re-apply over same home) ---')
delete globalThis.__x
soul.apply(ctx)
assert(/生日/.test(contexts['soul:recall'].text()), 'after re-apply (new session), memory still recalled')

console.log('--- soul_close_loop archives, removes from loops ---')
const c1 = await tools['soul_close_loop'].execute({ match: '桌面截图' })
assert(c1.closed === 1, 'closed 1 loop')
assert(!/桌面截图/.test(readFileSync(join(home, 'soul', 'loops.md'), 'utf8')), 'loop removed from loops.md')
assert(/桌面截图/.test(readFileSync(join(home, 'soul', 'loops.done.md'), 'utf8')), 'loop archived to loops.done.md')

console.log('--- soul_forget removes across files ---')
const f1 = await tools['soul_forget'].execute({ match: '生日' })
assert(f1.removed === 1, 'forgot 1 line')
assert(!/生日/.test(contexts['soul:recall'].text()), 'forgotten fact no longer recalled')

console.log('--- soul_write persona ---')
const wp = await tools['soul_write'].execute({ file: 'persona', content: '- 他爱被叫"杂鱼",讨厌助手腔,半夜活跃。' })
assert(wp.ok && wp.file === 'persona' && wp.items === 1, 'persona written, items 1')
assert(/杂鱼/.test(contexts['soul:recall'].text()), 'persona now surfaced in recall')

console.log('--- soul_write overwrites (consolidation) ---')
const wf = await tools['soul_write'].execute({ file: 'facts', content: '- 程序员,做 Windows/.NET。' })
assert(wf.items === 1, 'facts overwritten -> 1 item')
const recAfter = contexts['soul:recall'].text()
assert(/\.NET/.test(recAfter), 'new facts present after overwrite')
assert(!/生日/.test(recAfter), 'previously-forgotten fact still gone after overwrite')

console.log('--- soul_write rejects unknown file ---')
let wthrew = false
try { await tools['soul_write'].execute({ file: 'secrets', content: 'x' }) } catch { wthrew = true }
assert(wthrew, 'unknown soul_write target rejected')

console.log('--- soul_list returns all-defined strings (lossless) ---')
const l1 = await tools['soul_list'].execute()
assert(Object.values(l1).every((v) => v !== undefined), 'no undefined fields: ' + JSON.stringify(l1).slice(0, 80))

console.log('--- empty content rejected ---')
let threw = false
try { await tools['soul_remember'].execute({ content: '   ' }) } catch { threw = true }
assert(threw, 'blank content throws')

console.log('--- schema required arrays well-formed (must be arrays, not on fields) ---')
for (const t of Object.values(tools)) {
  assert(Array.isArray(t.output.schema.required), `${t.name}: required is an array`)
}

rmSync(home, { recursive: true, force: true })
console.log('\nRESULT:', process.exitCode === 1 ? 'HAS FAILURES' : 'ALL PASS')
