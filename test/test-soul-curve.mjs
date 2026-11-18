import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as soul from '../index.js'

const DAY = 86400000
const home = mkdtempSync(join(tmpdir(), 'soul-curve-'))
mkdirSync(join(home, 'soul'), { recursive: true })
const iso = (ago) => new Date(Date.now() - ago * DAY).toISOString().slice(0, 10)

const tools = {}
const contexts = {}
const sections = {}
const ctx = {
  profileContext: { home },
  effect: (fn) => { fn() },
  systemPrompt: { context: (d) => { contexts[d.name] = d; return () => {} }, section: (d) => { sections[d.name] = d; return () => {} } },
  tools: { register: (t) => { tools[t.name] = t } },
}
const P = (f) => join(home, 'soul', f)
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exitCode = 1 } else console.log('  ok:', m) }

// Seed notes BEFORE apply so the boot sweep can fade the ancient, never-reinforced one.
writeFileSync(P('notes.md'), '# 零散观察\n- [' + iso(0) + '] 今天的笔记\n- [2000-01-01] 老掉牙的笔记\n')

console.log('--- boot: apply + forgetting sweep ---')
soul.apply(ctx)
assert(existsSync(P('facts.faded.md')), 'sweep archived faded items into facts.faded.md')
const notes = readFileSync(P('notes.md'), 'utf8')
assert(/今天的笔记/.test(notes), 'recent note (in grace) kept on live file')
assert(!/老掉牙/.test(notes), 'ancient note removed from live file by sweep')
assert(/老掉牙/.test(readFileSync(P('facts.faded.md'), 'utf8')), 'ancient note landed in faded archive')

console.log('--- soul_remember writes decay metadata ---')
const r1 = await tools.soul_remember.execute({ content: '他喜欢苹果' })
assert(r1.ok && r1.items === 1 && r1.reinforced === false, 'first remember is a new fact, not a reinforce')
const facts = readFileSync(P('facts.md'), 'utf8')
assert(/<!--c=\d{4}-\d{2}-\d{2} r=\d{4}-\d{2}-\d{2} n=1 k=fact-->/.test(facts), 'bullet carries inline decay metadata: ' + facts.split('\n').pop())
assert(contexts['soul:recall'].text().includes('他喜欢苹果'), 'fact recalled by clean text')
assert(!contexts['soul:recall'].text().includes('<!--'), 'metadata never leaks into the recall block')
assert(!contexts['soul:recall'].text().includes('[20'), 'date prefix never leaks into the recall block')

console.log('--- re-remember same fact = reinforcement (no dup, n grows) ---')
const r2 = await tools.soul_remember.execute({ content: '他喜欢苹果' })
assert(r2.reinforced === true && r2.items === 1, 'duplicate remember reinforces instead of duplicating')
assert(/n=2 k=fact/.test(readFileSync(P('facts.md'), 'utf8')), 'review count bumped to 2 in file')

console.log('--- soul_touch reinforces by substring ---')
const t1 = await tools.soul_touch.execute({ match: '苹果' })
assert(t1.touched === true && t1.reviews === 3 && t1.retention === 100, 'touch -> reviews 3, full retention: ' + JSON.stringify(t1))
const t2 = await tools.soul_touch.execute({ match: '不存在的记忆zzz' })
assert(t2.touched === false, 'touch on no match reports not touched')

console.log('--- persona never decays (always recalled) ---')
await tools.soul_write.execute({ file: 'persona', content: '- 讨厌助手腔。' })
assert(/讨厌助手腔/.test(contexts['soul:recall'].text()), 'persona surfaced regardless of curve')

console.log('--- soul_list exposes the computed curve ---')
const l = await tools.soul_list.execute()
assert(typeof l.curve === 'string' && Array.isArray(JSON.parse(l.curve)), 'soul_list.curve is JSON array')
const apple = JSON.parse(l.curve).find((x) => x.text === '他喜欢苹果')
assert(apple && apple.n === 3 && apple.R === 100, 'curve row reflects 3 reviews at 100%: ' + JSON.stringify(apple))

console.log('--- soul_dashboard renders a self-contained, safe HTML ---')
// plant a hostile memory that, if not escaped, would break out of the JSON <script> block
await tools.soul_remember.execute({ content: '坏 </script><img src=x onerror=alert(1)>' })
const d = await tools.soul_dashboard.execute({})
assert(d.ok && existsSync(P('dashboard.html')), 'dashboard.html written')
const html = readFileSync(P('dashboard.html'), 'utf8')
assert(html.includes('<!doctype html>') && !html.includes('__DATA__'), 'template placeholder replaced')
assert(html.includes('他喜欢苹果') && html.includes('"retention"'), 'memory + computed retention baked into data')
const blob = /<script id="d"[^>]*>([\s\S]*?)<\/script>/.exec(html)
assert(blob && !blob[1].includes('<'), 'data blob contains no raw "<" (hostile text stayed \\u003c-escaped)')
assert(blob && blob[1].includes('\\u003c'), 'escaped placeholder present for the hostile line')

console.log('--- fade math on a recalled kind (loops): old low-stability item drops out ---')
writeFileSync(P('loops.md'), '# 你记挂着的事\n- [' + iso(0) + '] 新鲜的待办\n- [' + iso(200) + '] 两百天没提的待办\n')
const rec = contexts['soul:recall'].text()
assert(/新鲜的待办/.test(rec), 'recent loop IS recalled (control)')
assert(!/两百天/.test(rec), 'ancient loop faded out of the recall block (still on disk)')
assert(/两百天/.test(readFileSync(P('loops.md'), 'utf8')), 'faded-from-recall loop is NOT deleted from disk')

rmSync(home, { recursive: true, force: true })
console.log('\nRESULT:', process.exitCode === 1 ? 'HAS FAILURES' : 'ALL PASS')
