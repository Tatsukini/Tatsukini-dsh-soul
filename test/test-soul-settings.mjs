// Deterministic test for the soul settings layer: the /soul/prefs route (GET masked + PUT save),
// prefs merge/clamp/unknown-drop, API-key preservation through a masked echo, and the balance floor
// that gates the auto-continue hook. We drive the captured HTTP handler with tiny req/res fakes and
// stub global.fetch so the guard path is exercised without touching the real DeepSeek endpoint.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'

process.env.SOUL_LIANGWEN_CONFIG = join(tmpdir(), 'no-such-liangwen-config.json')
process.env.DEEPSEEK_API_KEY = ''

let fetchCalls = 0
let mockBalance = '0.50'
globalThis.fetch = async () => {
  fetchCalls += 1
  return { ok: true, status: 200, json: async () => ({ is_creatable: true, balance_infos: [{ total_balance: mockBalance, currency: 'CNY' }] }) }
}

const soul = await import(new URL('../index.js', import.meta.url).href)
const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1 } else { console.log('  ok:', msg) } }
const tick = () => new Promise((r) => setTimeout(r, 25))

function makeReq(method, payload) { const req = new EventEmitter(); req.method = method; req.destroy = () => {}; if (payload !== undefined) setImmediate(() => { req.emit('data', Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload))); req.emit('end') }); return req }
function makeRes() { const res = new EventEmitter(); res.headers = {}; res.body = ''; res.writeStatus = 0; res.writeHead = (s, h) => { res.writeStatus = s; Object.assign(res.headers, h || {}); return res }; res.end = (t) => { res.body = t || ''; res.emit('done') }; return res }
async function doPut(payload) { const req = makeReq('PUT', payload); const res = makeRes(); await handler(req, res); await tick(); return res }
async function doGet() { const res = makeRes(); await handler(makeReq('GET'), res); return res }

const home = mkdtempSync(join(tmpdir(), 'soul-settings-'))
const soulDir = join(home, 'soul')
mkdirSync(soulDir, { recursive: true })
const prefsPath = join(soulDir, 'prefs.json')
writeFileSync(prefsPath, JSON.stringify({
  baseLoopDays: 40, balanceGuardEnabled: true, balanceFloorYuan: 3,
  autoEnabled: true, autoCooldownSec: 0, deepseekApiKey: 'sk-UNITTEST-key9',
}), 'utf8')

let handler = null
const listeners = {}
const ctx = {
  profileContext: { home },
  effect: (fn) => { fn(); return () => {} },
  systemPrompt: { context: () => () => {}, section: () => () => {} },
  tools: { register: () => {} },
  on: (name, cb) => { listeners[name] = cb; return () => true },
  inject: (deps, fn) => { fn({ get: (k) => (k === 'webServer' ? { register: (o) => { handler = o.handler; return () => true } } : null), effect: (f) => { f(); return () => {} } }); return false },
}

console.log('--- apply() captures the /soul/prefs handler + the bus listener ---')
soul.apply(ctx)
assert(typeof handler === 'function', 'prefs route handler registered via webServer')
assert(typeof listeners['agent/status'] === 'function', 'agent/status listener captured')

console.log('--- GET returns prefs with the key masked, plaintext never in the response ---')
let res = makeRes()
await handler(makeReq('GET'), res)
assert(res.writeStatus === 200, 'GET 200')
let body = JSON.parse(res.body)
assert(body.prefs.deepseekApiKey === '****key9', 'key returned masked to last 4 only')
assert(res.body.indexOf('sk-UNITTEST-key9') === -1, 'plaintext key never present in GET response')
assert(body.hasKey === true, 'hasKey true')
assert(body.balance === 0.5, 'balance parsed from balance_infos sum')
assert(body.prefs.balanceFloorYuan === 3, 'floor echoed from prefs')

console.log('--- PUT saves + clamps + drops unknown keys, masked echo preserves the stored key ---')
const payload = { baseLoopDays: 10, fadePercent: 20, prunePercent: -5, balanceFloorYuan: 999999, deepseekApiKey: '****key9', surprise: 'x' }
const putRes = await doPut(payload)
assert(putRes.writeStatus === 200, 'PUT 200')
const saved = JSON.parse(readFileSync(prefsPath, 'utf8'))
assert(saved.baseLoopDays === 10, 'baseLoopDays updated')
assert(saved.fadePercent === 20, 'fadePercent updated')
assert(saved.prunePercent === 0, 'prunePercent clamped at 0')
assert(saved.balanceFloorYuan === 100000, 'floor clamped at range max')
assert(saved.deepseekApiKey === 'sk-UNITTEST-key9', 'stored key preserved through masked echo')
assert(!('surprise' in saved), 'unknown key dropped')
const putResp = JSON.parse(putRes.body)
assert(putResp.prefs.deepseekApiKey === '****key9', 'PUT response also masks the key')

console.log('--- balance floor BLOCKS the hook when balance < floor ---')
// Re-establish a sane floor (the clamp test above pushed it to the max, which would block everything).
mockBalance = '0.50'
await doPut({ balanceGuardEnabled: true, balanceFloorYuan: 3, autoEnabled: true, autoCooldownSec: 0 })
const day = new Date(Date.now() - 95 * 86400000).toISOString().slice(0, 10)
const ripeLine = (t) => `- [${day}] ${t} <!--c=${day} r=${day} n=1 k=loop-->`
writeFileSync(join(soulDir, 'loops.md'), '# 你记挂着的事\n' + ripeLine('测试钩子余额门') + '\n', 'utf8')
const fired = []
const agent = { followup: (m) => fired.push(m) }
listeners['agent/status']({ agent, status: 'idle' })
await tick()
assert(fired.length === 0, 'low balance -> no continuation fired')
assert(fetchCalls >= 1, 'guard consulted the balance endpoint')

console.log('--- guard OFF fires without spending a balance call ---')
const before = fetchCalls
await doPut({ balanceGuardEnabled: false, balanceFloorYuan: 3, autoEnabled: true, autoCooldownSec: 0 })
listeners['agent/status']({ agent, status: 'idle' })
await tick()
assert(fetchCalls === before, 'guard disabled -> balance endpoint not consulted')
assert(fired.length === 1, 'guard off -> the keeper raises the loop')

console.log('--- above the floor the hook fires again (PUT cleared the balance cache) ---')
mockBalance = '50.00'
await doPut({ balanceGuardEnabled: true, balanceFloorYuan: 3, autoEnabled: true, autoCooldownSec: 0 })
// loop 1 is now in the seen-set, so a fresh ripe loop proves the allow path.
writeFileSync(join(soulDir, 'loops.md'), '# 你记挂着的事\n' + ripeLine('另一件搁下的事') + '\n', 'utf8')
listeners['agent/status']({ agent, status: 'idle' })
await tick()
const gres = await doGet()
assert(JSON.parse(gres.body).balance === 50, 'balance refreshed past the floor on cache reset')
assert(fired.length === 2, 'sufficient balance -> the keeper raises the second loop')

rmSync(home, { recursive: true, force: true })
console.log('\nRESULT:', process.exitCode === 1 ? 'HAS FAILURES' : 'ALL PASS')
