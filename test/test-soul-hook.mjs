// Deterministic test for the soul:auto hook — monitors the cordis 'agent/status' bus event and,
// on an idle transition with a ripe open loop, fires ONE agent-initiated continuation turn.
// We capture the registered listener via a mock ctx.on, hand it a fake agent whose followup is a
// spy, and assert the wake message is built and de-duplicated. No live model needed — same reason
// test-soul.mjs calls execute() directly.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

// Force the balance guard off before import so the deterministic hook test never hits the network.
// Also force ASK mode so the nudge wording is stable ("要不要现在推进") for these assertions.
process.env.SOUL_BALANCE_GUARD = '0'
process.env.SOUL_AUTO_ACT = '0'

const soul = await import(new URL('../index.js', import.meta.url).href)

const home = mkdtempSync(join(tmpdir(), 'soul-hook-'))
const listeners = {}
const ctx = {
  profileContext: { home },
  effect: (fn) => { fn(); return () => {} },
  systemPrompt: { context: () => () => {}, section: () => () => {} },
  tools: { register: () => {} },
  on: (name, cb) => { listeners[name] = cb; return () => true },
}
const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1 } else { console.log('  ok:', msg) } }
const tick = () => new Promise((r) => setTimeout(r, 15)) // let buildUserMessage's awaited (rejected) import settle
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10)

console.log('--- apply() registers an agent/status listener ---')
soul.apply(ctx)
assert(typeof listeners['agent/status'] === 'function', 'agent/status listener captured (hook is live)')

console.log('--- idle with NO loops fires nothing ---')
let fired = []
const spyAgent = { followup: (m) => { fired.push(m) } }
listeners['agent/status']({ agent: spyAgent, status: 'idle' })
await tick()
assert(fired.length === 0, 'no ripe loop -> no continuation turn')

console.log('--- idle with a ripe (near-fade) loop fires exactly one agent-initiated turn ---')
// loop BASE=40,n=1: S=40. Created 95d ago => R=e^-95/40=0.093 (>=FADE 0.08, still live),
// daysToFade = 40*ln(12.5) - 95 = ~6d (<= AUTO_HORIZON 10) -> ripe.
const created = iso(95)
writeFileSync(join(home, 'soul', 'loops.md'),
  '# 你记挂着的事\n'
  + `- [${created}] 帮我把桌面截图按月份归档 <!--c=${created} r=${created} n=1 k=loop-->\n`, 'utf8')
listeners['agent/status']({ agent: spyAgent, status: 'idle' })
await tick()
assert(fired.length === 1, 'ripe loop -> one followup() call')
const msg = fired[0]
assert(msg && Array.isArray(msg.content) && typeof msg.content[0].text === 'string', 'message has text content block')
assert(/桌面截图按月份归档/.test(msg.content[0].text), 'nudge references the remembered loop text')
assert(msg.source && msg.source.kind === 'soul', 'message tagged source.kind=soul (agent-initiated, not the user)')
assert(msg.role === 'user', 'delivered as a user-role turn the agent can wake on')
assert(/要不要现在推进/.test(msg.content[0].text), 'ask-mode nudge asks before acting (SOUL_AUTO_ACT=0)')

console.log('--- a second idle does NOT re-nag (cooldown + per-loop seen) ---')
listeners['agent/status']({ agent: spyAgent, status: 'idle' })
listeners['agent/status']({ agent: spyAgent, status: 'idle' })
await tick()
assert(fired.length === 1, 'still one continuation -> no nag-loop')

console.log('--- non-idle status is ignored ---')
listeners['agent/status']({ agent: spyAgent, status: 'running' })
await tick()
assert(fired.length === 1, 'running -> no continuation')

console.log('--- malformed payload never throws into the bus ---')
let threw = false
try { listeners['agent/status'](null); listeners['agent/status']({}); listeners['agent/status']({ agent: {}, status: 'idle' }) }
catch { threw = true }
await tick()
assert(!threw && fired.length === 1, 'bad payloads swallowed safely; agent without followup() is a no-op')

rmSync(home, { recursive: true, force: true })
console.log('\nRESULT:', process.exitCode === 1 ? 'HAS FAILURES' : 'ALL PASS')
