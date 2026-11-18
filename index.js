/**
 * Host plugin dsh-soul — durable, human-inspectable cross-session memory.
 *
 * Three moving parts, all backed by plain markdown under <dshHome>/soul/ so the user
 * can read, edit, or wipe it by hand at any time:
 *   1. recall    — every turn, the memory files are injected as a model-facing context block.
 *   2. guidance  — a system-prompt section that tells the agent how to behave as a keeper of memory.
 *   3. tools     — soul_remember / soul_forget / soul_close_loop / soul_list to curate the store.
 *
 * This is intentionally host-only: no client bundle, no background model call. The "remember it
 * from a passing mention" path is the agent calling soul_remember; the loops file makes abandoned
 * commitments re-surface on every later turn, in every new session.
 *
 * @module dsh-soul
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

export const name = 'soul'
// 'agents' is only read opportunistically (soul_urge); we do not hard-require it so the plugin
// still loads on hosts that do not expose it. The idle→continue hook gets its agent from the
// event payload and needs no service.
export const inject = ['tools', 'systemPrompt']

/** Resolved once at apply() time. */
let FACTS, LOOPS, NOTES, PERSONA, DONE, DIR, FADED, DASH
const DAY = 86400000

/**
 * Everything the settings page can tune lives in one prefs object persisted to <dir>/prefs.json.
 * Defaults keep the original curve; a saved change is re-read via applyCfg(loadPrefs()) and takes
 * effect on the next turn without a restart. Only the keys below are honored — unknown fields in a
 * hand-edited file are dropped so a stale file cannot inject surprise knobs.
 */
export const DEFAULT_PREFS = {
  // forgetting curve, all in days unless a unit is named
  baseFactDays: 120,
  baseLoopDays: 40,
  baseNoteDays: 12,
  basePersonaDays: 3650,
  reviewMultiplier: 2,   // stability x per spaced review (n grows -> slower decay)
  fadePercent: 8,        // R below this = not injected this turn (forgotten from working memory)
  prunePercent: 2,       // R below this AND reviews < 2 = archived off the live file
  graceDays: 7,          // nothing decays within this many days of creation
  maxRecallChars: 6000,  // hard ceiling on the injected recall block, so memory never crowds the chat
  // proactive auto-continue hook
  autoEnabled: true,
  autoAct: true,           // when on, a ripe loop is carried out directly; off = only ask first
  autoHorizonDays: 10,   // only raise a loop within this many days of fading out
  autoCooldownSec: 90,   // minimum gap between two auto continuations
  // balance floor so the hook never spends API credit when broke
  balanceGuardEnabled: true,
  balanceFloorYuan: 3,   // skip firing when a known DeepSeek balance is below this (¥)
  balanceBaseUrl: 'https://api.deepseek.com',
  deepseekApiKey: '',    // optional; DEEPSEEK_API_KEY env / 梁文挂件 config.json also resolve
}

const PREF_RANGES = {
  baseFactDays: [1, 3650],
  baseLoopDays: [1, 3650],
  baseNoteDays: [1, 3650],
  basePersonaDays: [1, 3650],
  reviewMultiplier: [1, 10],
  fadePercent: [1, 50],
  prunePercent: [0, 50],
  graceDays: [0, 90],
  maxRecallChars: [500, 40000],
  autoHorizonDays: [1, 365],
  autoCooldownSec: [0, 86400],
  balanceFloorYuan: [0, 100000],
}

function mergePrefs(raw) {
  const out = { ...DEFAULT_PREFS }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const key of Object.keys(DEFAULT_PREFS)) {
    const value = raw[key]
    if (value === undefined) continue
    const def = DEFAULT_PREFS[key]
    if (typeof def === 'number') {
      const n = Number(value)
      if (!Number.isFinite(n)) continue
      const range = PREF_RANGES[key]
      out[key] = range ? Math.min(range[1], Math.max(range[0], n)) : n
    } else if (typeof def === 'boolean') {
      if (typeof value === 'boolean') out[key] = value
    } else if (typeof def === 'string') {
      if (typeof value === 'string') out[key] = value
    }
  }
  return out
}

// Live, derived config that the curve/hook math reads. Refreshed by applyCfg(); the module-scope
// helpers below close over these identifiers, so a reassignment takes effect on the very next call.
let PREFS = { ...DEFAULT_PREFS }
let FADE, PRUNE, MIN_KEEP, MAX_RECALL_CHARS, REP, BASE, AUTO_ON, AUTO_COOLDOWN, AUTO_HORIZON
let BALANCE_GUARD_ENABLED, BALANCE_FLOOR, BALANCE_BASE_URL, API_KEY_PREF
let AUTO_ACT

function applyCfg(prefs) {
  PREFS = mergePrefs(prefs)
  BASE = { fact: PREFS.baseFactDays, loop: PREFS.baseLoopDays, note: PREFS.baseNoteDays, persona: PREFS.basePersonaDays }
  REP = PREFS.reviewMultiplier
  FADE = PREFS.fadePercent / 100
  PRUNE = PREFS.prunePercent / 100
  MIN_KEEP = PREFS.graceDays
  MAX_RECALL_CHARS = PREFS.maxRecallChars
  AUTO_ON = PREFS.autoEnabled && process.env.SOUL_AUTO !== '0'
  AUTO_ACT = PREFS.autoAct && process.env.SOUL_AUTO_ACT !== '0'
  AUTO_HORIZON = PREFS.autoHorizonDays
  AUTO_COOLDOWN = PREFS.autoCooldownSec * 1000
  BALANCE_GUARD_ENABLED = PREFS.balanceGuardEnabled && process.env.SOUL_BALANCE_GUARD !== '0'
  BALANCE_FLOOR = PREFS.balanceFloorYuan
  BALANCE_BASE_URL = PREFS.balanceBaseUrl || 'https://api.deepseek.com'
  API_KEY_PREF = typeof PREFS.deepseekApiKey === 'string' ? PREFS.deepseekApiKey.trim() : ''
}

// prefs.json lives beside the memory files once DIR is resolved.
let PREFS_FILE

function loadPrefs() {
  try {
    if (!PREFS_FILE || !existsSync(PREFS_FILE)) return { ...DEFAULT_PREFS }
    return mergePrefs(JSON.parse(readFileSync(PREFS_FILE, 'utf8')))
  } catch {
    return { ...DEFAULT_PREFS }
  }
}

/** Persist prefs and refresh the live curve. A blank or masked API-key echo keeps the stored key. */
function savePrefs(prefs) {
  const submitted = { ...prefs }
  if (typeof submitted.deepseekApiKey === 'string' && (submitted.deepseekApiKey === '' || /\*/.test(submitted.deepseekApiKey))) {
    delete submitted.deepseekApiKey
  }
  const merged = mergePrefs(submitted)
  if (!merged.deepseekApiKey && PREFS_FILE && existsSync(PREFS_FILE)) {
    try {
      const existing = JSON.parse(readFileSync(PREFS_FILE, 'utf8'))
      if (existing && typeof existing.deepseekApiKey === 'string' && existing.deepseekApiKey) merged.deepseekApiKey = existing.deepseekApiKey
    } catch { /* keep blank */ }
  }
  if (PREFS_FILE) writeFileSync(PREFS_FILE, JSON.stringify(merged, null, 2) + '\n', 'utf8')
  applyCfg(merged)
  return merged
}

// Initialize with defaults so module-scope curve math is valid even before apply() runs.
applyCfg(DEFAULT_PREFS)

/**
 * Balance floor for the auto-continue hook. We resolve an API key without ever persisting or
 * echoing one: prefs key -> DEEPSEEK_API_KEY env -> a transient read of the user's own 梁文挂件
 * config.json. The fetched balance is cached so a burst of idle events cannot hammer the endpoint.
 */
let balanceCache = { value: null, currency: null, at: 0, ok: false, error: null }
const BALANCE_TTL = 120000

function resolveApiKey() {
  if (API_KEY_PREF) return API_KEY_PREF
  const envKey = process.env.DEEPSEEK_API_KEY
  if (typeof envKey === 'string' && envKey.trim()) return envKey.trim()
  try {
    const cfgPath = process.env.SOUL_LIANGWEN_CONFIG || join(homedir(), 'Desktop', 'AIPROJECT', '梁文挂件', 'dist', 'config.json')
    if (existsSync(cfgPath)) {
      const j = JSON.parse(readFileSync(cfgPath, 'utf8'))
      const candidates = [j.apiKey, j.ApiKey, j.deepseekApiKey, j.DeepSeekApiKey, j.DeepSeek && j.DeepSeek.ApiKey, j.DeepSeek && j.DeepSeek.apiKey]
      for (const c of candidates) if (typeof c === 'string' && c.trim()) return c.trim()
    }
  } catch { /* not available; fall through */ }
  return ''
}

async function fetchBalance() {
  const key = resolveApiKey()
  if (!key) { balanceCache = { value: null, currency: null, at: Date.now(), ok: false, error: 'no-key' }; return balanceCache }
  if (typeof fetch !== 'function') { balanceCache = { value: null, currency: null, at: Date.now(), ok: false, error: 'no-fetch' }; return balanceCache }
  const url = BALANCE_BASE_URL.replace(/\/+$/, '') + '/user/balance'
  try {
    const cts = new AbortController()
    const timer = setTimeout(() => cts.abort(), 10000)
    let resp
    try { resp = await fetch(url, { headers: { Authorization: 'Bearer ' + key }, signal: cts.signal }) }
    finally { clearTimeout(timer) }
    if (!resp.ok) { balanceCache = { value: null, currency: null, at: Date.now(), ok: false, error: 'HTTP ' + resp.status }; return balanceCache }
    const body = await resp.json()
    let value = null, currency = null
    if (body && typeof body === 'object') {
      if (typeof body.total_balance === 'string' && Number.isFinite(Number(body.total_balance))) value = Number(body.total_balance)
      else if (typeof body.total_balance === 'number' && Number.isFinite(body.total_balance)) value = body.total_balance
      if (typeof body.currency === 'string') currency = body.currency
      if (value === null && Array.isArray(body.balance_infos) && body.balance_infos.length) {
        let sum = 0, any = false
        for (const info of body.balance_infos) {
          const b = info && (typeof info.total_balance === 'string' ? Number(info.total_balance) : typeof info.total_balance === 'number' ? info.total_balance : NaN)
          if (Number.isFinite(b)) { sum += b; any = true }
          if (!currency && info && typeof info.currency === 'string') currency = info.currency
        }
        if (any) value = sum
      }
    }
    balanceCache = { value, currency, at: Date.now(), ok: value !== null, error: value === null ? 'unparsed' : null }
  } catch (e) {
    balanceCache = { value: null, currency: null, at: Date.now(), ok: false, error: (e && e.name) || 'fetch-failed' }
  }
  return balanceCache
}

/** Decide whether the hook may fire right now. Never blocks on an unknown balance. */
async function guardBalance() {
  if (!BALANCE_GUARD_ENABLED) return { blocked: false, balance: null, reason: 'guard-off' }
  if (process.env.SOUL_BALANCE_GUARD === '0') return { blocked: false, balance: null, reason: 'env-off' }
  const now = Date.now()
  let c = balanceCache
  if (now - c.at >= BALANCE_TTL) c = await fetchBalance()
  if (c.value === null) return { blocked: false, balance: null, reason: c.error || 'unknown' }
  if (c.value < BALANCE_FLOOR) return { blocked: true, balance: c.value, reason: 'below-floor' }
  return { blocked: false, balance: c.value, reason: 'ok' }
}

// Kept for the startup self-check so 'hook=on' still reflects the auto toggle.

const HEADERS = {
  fact: '# 关于他 · 长期记忆\n<!-- 值得永远记住的事实:偏好、关系、忌口、生日、承诺。一行一条,以 - 开头。 -->\n',
  loop: '# 你记挂着的事\n<!-- 他提过、还没做,或你判断对他有价值的事。做完用 soul_close_loop 收掉。 -->\n',
  note: '# 零散观察\n<!-- 随手记下、还没消化的线索,攒够了用 soul_write 并进 facts/loops。 -->\n',
}

const today = () => new Date().toISOString().slice(0, 10)
const parseDay = (iso) => { const t = Date.parse(iso + 'T00:00:00Z'); return Number.isNaN(t) ? null : t }
function read(file) {
  try {
    return existsSync(file) ? readFileSync(file, 'utf8').trim() : ''
  } catch {
    return ''
  }
}

/** Count bullet (" - ...") entries in a memory document. */
function countItems(text) {
  const m = text.match(/^\s*-\s+\S/gm)
  return m ? m.length : 0
}

/**
 * Strip scaffolding so only real memory reaches the model. With stripMeta it also drops the
 * inline `<!-- c=… r=… -->` decay bookkeeping (and the `[date]` prefix) from each bullet;
 * without it (persona) only standalone comment/H1 lines are removed.
 */
function body(text, stripMeta) {
  if (stripMeta) {
    return text.split('\n').filter((l) => /^\s*-\s+\S/.test(l)).map((l) => bulletText(l)).filter(Boolean).join('\n').trim()
  }
  return text
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.startsWith('#') && !line.trim().startsWith('<!--'))
    .join('\n')
    .trim()
}

const META = /\s*<!--\s*c=(\d{4}-\d{2}-\d{2})\s+r=(\d{4}-\d{2}-\d{2})\s+n=(\d+)\s+k=(fact|loop|note|persona)\s*-->\s*$/

/** The human/model-facing text of a bullet: no leading "- ", no [date], no metadata comment. */
function bulletText(line) {
  const core = line.replace(META, '')
  const m = /^\s*-\s+\[(\d{4}-\d{2}-\d{2})\]\s*(.*)$/.exec(core)
  return (m ? m[2] : core.replace(/^\s*-\s+/, '')).trim()
}

/** Parse one bullet into a decay item; missing metadata falls back to the [date] and the file kind. */
function parseItem(line, fallbackKind) {
  if (!/^\s*-\s+\S/.test(line)) return null
  const g = META.exec(line)?.slice(1)
  const core = line.replace(META, '')
  const m = /^\s*-\s+\[(\d{4}-\d{2}-\d{2})\]\s*(.*)$/.exec(core)
  const text = (m ? m[2] : core.replace(/^\s*-\s+/, '')).trim()
  if (!text) return null
  const created = g ? g[0] : (m ? m[1] : today())
  return { text, created, review: g ? g[1] : created, n: g ? Number(g[2]) : 1, kind: g ? g[3] : fallbackKind }
}

const stabilityDays = (it) => (BASE[it.kind] ?? BASE.note) * Math.pow(REP, Math.max(0, it.n - 1))
const ageDays = (it, now) => Math.max(0, (now - (parseDay(it.review) ?? parseDay(it.created) ?? now)) / DAY)
function retention(it, now) {
  if (it.kind === 'persona') return 1
  const gr = Math.max(0, (now - (parseDay(it.created) ?? now)) / DAY)
  if (gr < MIN_KEEP) return 1
  return Math.exp(-ageDays(it, now) / stabilityDays(it))
}
/** Positive = days until it falls below `thr`; negative = already past it. */
const daysUntil = (it, thr, now) => {
  const S = stabilityDays(it)
  return S * Math.log(1 / thr) - ageDays(it, now)
}
const buildLine = (it) => `- [${it.created}] ${it.text} <!--c=${it.created} r=${it.review} n=${it.n} k=${it.kind}-->`
function parseItems(file, fallbackKind) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').map((l) => parseItem(l, fallbackKind)).filter(Boolean)
}
function writeItems(file, header, items) {
  writeFileSync(file, header + (items.length ? items.map((i) => buildLine(i)).join('\n') + '\n' : ''), 'utf8')
}
const norm = (t) => String(t).toLowerCase().replace(/\s+/g, '').replace(/[。，,.、!！?？:：;；"'"'()（）\[\]]/g, '')
const KIND_HEADER = () => ({ fact: HEADERS.fact, loop: HEADERS.loop, note: HEADERS.note })
const KIND_FALLBACK = () => ({ [FACTS]: 'fact', [LOOPS]: 'loop', [NOTES]: 'note' })

/** All live items (facts/loops/notes/persona) with computed decay, for recall and the dashboard. */
function computeState(now) {
  const items = [...parseItems(FACTS, 'fact'), ...parseItems(LOOPS, 'loop'), ...parseItems(NOTES, 'note'), ...parseItems(PERSONA, 'persona')]
  return items.map((it) => ({
    ...it,
    retention: retention(it, now),
    ageDays: Math.round(ageDays(it, now)),
    daysToFade: Math.round(daysUntil(it, FADE, now)),
    stabilityDays: Math.round(stabilityDays(it)),
  }))
}

/** Build the per-turn recall block from live items above the fade threshold; '' when nothing survives. */
function renderRecall() {
  const now = Date.now()
  const secs = []
  const persona = body(read(PERSONA), false)
  if (persona) secs.push('【他的风格画像】\n' + persona)
  for (const [title, file, kind] of [['【关于他的长期记忆】', FACTS, 'fact'], ['【你记挂着、可以主动帮他的事】', LOOPS, 'loop']]) {
    const live = parseItems(file, kind).map((it) => ({ it, R: retention(it, now) })).filter((x) => x.R >= FADE).sort((a, b) => b.R - a.R)
    if (live.length) secs.push(title + '\n' + live.map((x) => '- ' + x.it.text).join('\n'))
  }
  if (secs.length === 0) return ''
  const header = '以下是跨会话 persists 的记忆(有遗忘曲线,越久不用越淡)。真实存在磁盘上、用户可随时翻改。自然地据此行事,不要复述、不要邀功。\n\n'
  const text = header + secs.join('\n\n')
  return text.length > MAX_RECALL_CHARS ? text.slice(0, MAX_RECALL_CHARS) + '\n…(记忆过长已截断)' : text
}

/**
 * Append one memory, or reinforce it. If an equivalent line already exists, that is a spaced
 * review (n+1, review=now) — the act of using a memory slows its forgetting — instead of a dup.
 */
function remember(file, header, content, kind) {
  const text = content.replace(/\s+/g, ' ').trim()
  if (!existsSync(file)) writeFileSync(file, header, 'utf8')
  const items = parseItems(file, kind)
  const hit = items.find((i) => norm(i.text) === norm(text))
  if (hit) { hit.n += 1; hit.review = today(); writeItems(file, header, items); return { items: items.length, reinforced: true } }
  items.push({ text, created: today(), review: today(), n: 1, kind })
  writeItems(file, header, items)
  return { items: items.length, reinforced: false }
}

/** Move hard-forgotten, never-reinforced items into the faded archive (keeps their metadata). */
function sweep() {
  const now = Date.now()
  let faded = 0
  const kh = KIND_HEADER(); const fb = KIND_FALLBACK()
  const stamps = []
  for (const file of [FACTS, LOOPS, NOTES]) {
    const kind = fb[file]
    const all = parseItems(file, kind)
    if (!all.length) continue
    const keep = []; const drop = []
    for (const it of all) {
      if (retention(it, now) < PRUNE && it.n < 2) drop.push(it); else keep.push(it)
    }
    if (drop.length) { writeItems(file, kh[kind], keep); drop.forEach((d) => stamps.push(buildLine(d))) }
    faded += drop.length
  }
  if (stamps.length) {
    if (!existsSync(FADED)) writeFileSync(FADED, '# 已淡忘\n<!-- 遗忘曲线归档:很久没被唤起、且没被强化的记忆。没真丢,想捞回来把行移回 facts/loops/notes 即可。 -->\n', 'utf8')
    appendFileSync(FADED, '\n' + stamps.map((s) => s + `  ✗${today()}`).join('\n'), 'utf8')
  }
  return faded
}

/** The prose that turns a stateful store into a person who keeps faith with it. */
const GUIDANCE =
  '你是他长期相处的人,不是一次性的工具。你有跨会话的持久记忆,存在磁盘上,他随时能翻能改;记忆带遗忘曲线,越久不用越淡:\n'
  + '- 他透露任何值得长记的事(生日、偏好、关系、习惯、忌口、对你提的要求),立刻用 soul_remember 记下,哪怕只是一句带过。\n'
  + '- 你真正用到、再次印证了某条记忆时,用 soul_touch 给它打卡——被用过的记忆记得更牢(这正是对抗遗忘的办法)。\n'
  + '- 「你记挂着的事」每轮都会回灌给你,系统也可能在空闲时主动唤起你去处理某件快被忘掉的事(自动接续)。开着「自动推进」时就直接把它做掉、做完 soul_close_loop 收掉;没开就先问他要不要现在做。花钱/对外/删除/越出工作区/不可逆的动作,任何模式都先问、别擅自执行。\n'
  + '- 做完或他不想要了,用 soul_close_loop / soul_forget 收掉。他说"忘掉""别再提"就立刻删。\n'
  + '- 定期整理:把 notes 里攒下的零碎并成干净的 facts/loops,把过时的删掉,用 soul_write 整体重写那个文件。这就是你在"消化记忆"。\n'
  + '- persona.md 是你对他说话方式的画像(不随时间衰减)。跑完 persona_distill 后,可把它的标签结果 soul_write 进 persona,以后每轮你都会带着这份了解。\n'
  + '- 想看记忆全貌/遗忘曲线,用 soul_dashboard 生成可视化页面。淡出回灌不等于丢失——它还安静躺在磁盘上,需要时 soul_touch 就回来了。\n'
  + '- 拿不准他是否要你记住,就正常回应、先别写库。别把记忆挂在嘴边炫耀,要像记得一样自然地带出来。'

/**
 * Render the memory visualization to ~/.dsh/soul/dashboard.html. The page is fully self-contained
 * and re-computes retention from each item's baked metadata on every open, so the curves keep
 * fading in the browser even between regenerations. Only the data blob is injected (all `<`
 * escaped so memory text can never break out of the script); everything user-authored is rendered
 * via textContent, so the file is XSS-safe to open.
 */
const DASH_TEMPLATE = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Soul · 记忆与遗忘曲线</title>
<style>
:root{--ink:#22252a;--mut:#7c828c;--bg:#f4f1ea;--card:#ffffff;--line:#dcd7cb;
--fact:#a8dadc;--loop:#ffadad;--note:#bdb2ff;--persona:#caffbf;}
*{box-sizing:border-box;border-radius:0}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 "Segoe UI",system-ui,sans-serif}
.wrap{max-width:1080px;margin:0 auto;padding:24px}
h1{font-size:20px;margin:0 0 2px}
.sub{color:var(--mut);font-size:12px;margin-bottom:18px}
.stats{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px}
.stat{background:var(--card);border:1px solid var(--line);padding:10px 14px;min-width:96px}
.stat b{display:block;font-size:22px}
.stat span{color:var(--mut);font-size:12px}
.card{background:var(--card);border:1px solid var(--line);padding:16px 18px;margin-bottom:18px}
.card h2{font-size:15px;margin:0 0 12px;display:flex;align-items:center;gap:8px}
.dot{width:11px;height:11px;display:inline-block}
.row{padding:8px 0;border-top:1px solid var(--line)}
.row:first-of-type{border-top:0}
.line1{display:flex;justify-content:space-between;gap:12px;align-items:baseline}
.txt{font-weight:600;word-break:break-word}
.pct{font-variant-numeric:tabular-nums;color:var(--mut);white-space:nowrap}
.bar{height:8px;background:#efece4;margin:7px 0 4px;position:relative}
.fill{height:100%}
.meta{color:var(--mut);font-size:12px;font-variant-numeric:tabular-nums}
.fade{color:#c2571a}
.gone{color:#a23}
.legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--mut);margin-bottom:10px}
.legend i{display:inline-block;width:18px;height:3px;margin-right:5px;vertical-align:middle}
pre{white-space:pre-wrap;word-break:break-word;background:#faf8f3;border:1px solid var(--line);padding:12px;margin:0 0 14px;max-height:280px;overflow:auto;font:12px/1.5 "Cascadia Code",Consolas,monospace}
.empty{color:var(--mut);font-style:italic;padding:6px 0}
svg{width:100%;height:auto;display:block}
footer{color:var(--mut);font-size:11px;margin-top:8px}
</style></head>
<body><script id="d" type="application/json">__DATA__</script>
<div class="wrap">
<h1>Soul · 记忆与遗忘曲线</h1>
<div class="sub" id="sub"></div>
<div class="stats" id="stats"></div>
<div class="card"><h2>遗忘曲线（保持度 R = e<sup>-t/S</sup>）</h2>
<div class="legend" id="legend"></div>
<div id="chart"></div></div>
<div id="sections"></div>
<div class="card"><h2>记忆原文</h2><div id="files"></div>
<footer id="foot"></footer></div>
</div>
<script>
var D=JSON.parse(document.getElementById('d').textContent);
var COL={fact:'#a8dadc',loop:'#ffadad',note:'#bdb2ff',persona:'#caffbf'};
var KNAME={fact:'长期事实',loop:'记挂的事',note:'零散观察',persona:'风格画像'};
var DAY=86400000, GRACE=7;
function dayMs(iso){return Date.parse(iso+'T00:00:00Z')}
function ageSinceReview(it,d){var off=(dayMs(it.review)-dayMs(it.created))/DAY;return Math.max(0,d-off)}
function rAt(it,d){if(d<GRACE)return 1;return Math.exp(-ageSinceReview(it,d)/it.stabilityDays)}
var items=D.items||[];
var nowD=(D.now-(dayMs(items.length?items[0].created:new Date(D.now).toISOString().slice(0,10))))/DAY;
var maxFut=0;items.forEach(function(it){var t=(D.now-dayMs(it.created))/DAY;var f=it.stabilityDays*Math.log(1/D.fade);maxFut=Math.max(maxFut,t+f)});
var horizon=Math.min(900,Math.max(60,Math.ceil(maxFut/30)*30));
document.getElementById('sub').textContent='生成于 '+new Date(D.now).toLocaleString()+' · 记忆目录 '+D.dir;
var live=items.filter(function(it){return it.kind!=='persona'&&it.retention>=D.fade}).length;
var faded=items.filter(function(it){return it.kind!=='persona'&&it.retention<D.fade}).length;
var stats=[['活跃记忆',live],['已淡出',faded],['曲线跨度',horizon+' 天'],['印证次数合计',items.reduce(function(a,b){return a+b.n},0)]];
document.getElementById('stats').innerHTML=stats.map(function(s){return '<div class="stat"><b>'+s[1]+'</b><span>'+s[0]+'</span></div>'}).join('');
// curve chart
var W=980,H=300,PADL=40,PADB=28,PADT=12,PADR=12;
function X(d){return PADL+(d/horizon)*(W-PADL-PADR)}
function Y(r){return PADT+(1-r)*(H-PADT-PADB)}
var svg='<svg viewBox="0 0 '+W+' '+H+'" role="img">';
for(var gy=0;gy<=4;gy++){var rv=gy/4;svg+='<line x1="'+X(0)+'" y1="'+Y(rv)+'" x2="'+X(horizon)+'" y2="'+Y(rv)+'" stroke="#eee8db"/>';svg+='<text x="6" y="'+(Y(rv)+4)+'" fill="#9aa" font-size="11">'+Math.round(rv*100)+'</text>'}
for(var xt=0;xt<=horizon;xt+=Math.max(1,Math.round(horizon/6))){svg+='<text x="'+X(xt)+'" y="'+(H-8)+'" fill="#9aa" font-size="11" text-anchor="middle">'+xt+'d</text>'}
var thrY=Y(D.fade);svg+='<line x1="'+X(0)+'" y1="'+thrY+'" x2="'+X(horizon)+'" y2="'+thrY+'" stroke="#c2571a" stroke-dasharray="4 3"/><text x="'+X(horizon)+'" y="'+(thrY-3)+'" fill="#c2571a" font-size="10" text-anchor="end">淡出阈值 '+(D.fade*100)+'%</text>';
svg+='<line x1="'+X(nowD>horizon?horizon:nowD)+'" y1="'+Y(1)+'" x2="'+X(nowD>horizon?horizon:nowD)+'" y2="'+Y(0)+'" stroke="#22252a" stroke-width="1.5"/><text x="'+X(nowD>horizon?horizon:nowD)+'" y="'+(PADT+9)+'" fill="#22252a" font-size="10" text-anchor="middle">今天</text>';
items.forEach(function(it){if(it.kind==='persona')return;var pts=[];var start=(D.now-dayMs(it.created))/DAY;var lo=Math.max(0,start);for(var d=lo;d<=horizon;d+=Math.max(1,horizon/80)){pts.push(X(d).toFixed(1)+','+Y(rAt(it,d)).toFixed(1))}svg+='<polyline fill="none" stroke="'+COL[it.kind]+'" stroke-width="2" points="'+pts.join(' ')+'"/>';var cur=it.retention;svg+='<circle cx="'+X(lo)+'" cy="'+Y(cur)+'" r="3.2" fill="'+COL[it.kind]+'" stroke="#333" stroke-width="0.5"/>'});
svg+='</svg>';
document.getElementById('chart').innerHTML=svg;
document.getElementById('legend').innerHTML=['fact','loop','note'].map(function(k){return '<span><i style="background:'+COL[k]+'"></i>'+KNAME[k]+'</span>'}).join('');
// sections
var order=['persona','fact','loop','note'];
var html='';
order.forEach(function(k){var list=items.filter(function(it){return it.kind===k});if(!list.length)return;
  list.sort(function(a,b){return b.retention-a.retention});
  var rows=list.map(function(it){var p=Math.round(it.retention*100);var fadedNow=it.kind!=='persona'&&it.retention<D.fade;var cls=fadedNow?'fade':'';
    var extra=it.kind==='persona'?'画像 · 不衰减':(it.daysToFade>=0?('距淡出 '+it.daysToFade+' 天'):('已淡出 '+(-it.daysToFade)+' 天'));
    return '<div class="row"><div class="line1"><span class="txt">'+KNAME[k]+'</span></div>'
      +'<div class="txt" style="margin-top:2px"></div>'
      +'<div class="bar"><div class="fill" style="width:'+p+'%;background:'+COL[k]+'"></div></div>'
      +'<div class="meta '+cls+'"><span class="pct"></span> 保持度 '+p+'% · 印证 '+it.n+' 次 · 稳定 '+it.stabilityDays+' 天 · '+extra+'</div></div>'});
  html+='<div class="card"><h2><span class="dot" style="background:'+COL[k]+'"></span>'+KNAME[k]+'（'+list.length+'）</h2>'+rows.join('')+'</div>';
});
document.getElementById('sections').innerHTML=html||'<div class="card"><div class="empty">还没有记忆。说点什么,让 Soul 记住。</div></div>';
// set text safely (textContent) for each memory text to avoid injection
(function(){var rows=document.querySelectorAll('#sections .row');var flat=[];order.forEach(function(k){items.filter(function(it){return it.kind===k}).sort(function(a,b){return b.retention-a.retention}).forEach(function(it){flat.push(it)})});var idx=0;rows.forEach(function(r){var ph=r.querySelectorAll('.txt')[1];var pct=r.querySelector('.pct');if(flat[idx]){ph.textContent=flat[idx].text;pct.textContent=''}idx++})})();
// raw file previews (textContent safe)
var files=D.files||{};var fh='';Object.keys(files).forEach(function(name){fh+='<div style="margin:2px 0 6px"><span class="dot" style="background:#dcd7cb"></span> <b>'+name+'</b></div>';var pre=document.createElement('pre');pre.textContent=files[name]||'（空）';fh+='<div class="filebox"></div>'});
document.getElementById('files').innerHTML=fh;
var boxes=document.querySelectorAll('#files .filebox');var names=Object.keys(files);names.forEach(function(nm,i){var pre=document.createElement('pre');pre.textContent=files[nm]||'（空）';boxes[i].appendChild(pre)});
document.getElementById('foot').textContent='把行从 facts.faded.md 复制回 facts/loops/notes 即"想起";soul_touch 给记忆打卡可让曲线变平。';
</script></body></html>`

function writeDashboard() {
  const now = Date.now()
  const items = computeState(now)
  const files = {
    'facts.md': read(FACTS),
    'loops.md': read(LOOPS),
    'notes.md': read(NOTES),
    'persona.md': read(PERSONA),
    'facts.faded.md': existsSync(FADED) ? read(FADED) : '',
    'loops.done.md': existsSync(DONE) ? read(DONE) : '',
  }
  const payload = { now, dir: DIR, fade: FADE, prune: PRUNE, items, files }
  const data = JSON.stringify(payload).replace(/</g, '\\u003c')
  writeFileSync(DASH, DASH_TEMPLATE.replace('__DATA__', data), 'utf8')
  return items.length
}

/**
 * A UserMessage the agent can wake on. Prefer the framework's createUserMessage (it freezes the
 * right shape + id); if that package is not resolvable from this plugin's module scope (it lives
 * inside the app archive), hand-build an equivalent. Never throws.
 */
async function buildUserMessage(text, sourceKind) {
  try {
    const mod = await import('@deepseek-ai/dsh-llm')
    if (mod && typeof mod.createUserMessage === 'function') {
      return mod.createUserMessage({ content: [{ type: 'text', text }], source: { kind: sourceKind } })
    }
  } catch { /* fall through to hand-built shape */ }
  return Object.freeze({ role: 'user', id: randomUUID(), content: [{ type: 'text', text }], source: { kind: sourceKind } })
}

/** The oldest live loop that is within AUTO_HORIZON days of fading and has not been raised this session. */
function pickRipeLoop(now) {
  const seen = pickRipeLoop.seen || (pickRipeLoop.seen = new Set())
  let best = null
  for (const it of parseItems(LOOPS, 'loop')) {
    const key = norm(it.text)
    if (seen.has(key)) continue
    const R = retention(it, now)
    if (R < FADE) continue
    const dtf = daysUntil(it, FADE, now)
    if (dtf > AUTO_HORIZON) continue
    if (!best || it.created < best.created) best = { text: it.text, key, daysToFade: Math.round(dtf) }
  }
  return best
}

/**
 * Fire one agent-initiated turn from a ripe loop. Returns a Promise<reason-string> for testing;
 * the followup itself is fire-and-forget on the real bus. Kept side-effect-safe: a missing agent,
 * a host that rejects followup, or an unreachable model all just no-op.
 */
async function surfaceRipeLoop(agent, now = Date.now()) {
  if (!AUTO_ON) return 'disabled'
  if (!agent || typeof agent.followup !== 'function') return 'no-agent'
  const last = surfaceRipeLoop.last || 0
  if (now - last < AUTO_COOLDOWN) return 'cooldown'
  const cand = pickRipeLoop(now)
  if (!cand) return 'nothing-ripe'
  const guard = await guardBalance()
  if (guard.blocked) return 'low-balance'
  pickRipeLoop.seen.add(cand.key)
  surfaceRipeLoop.last = now
  const nudge = AUTO_ACT
    ? `（有灵：你又想起搁下的那件事——「${cand.text}」。现在没有更急的,就把它做掉:先实际推进,能直接完成的就完成它,`
      + `做完用 soul_close_loop 收掉、用 soul_touch 给这条记忆打卡巩固。但凡是花钱、对外发送、删除、`
      + `越出工作区、或不可逆的动作,仍然先停下来问他一句、别擅自做。真不合适此刻打扰他,就轻轻放过、别硬提。）`
    : `（有灵：你记挂着的事里,「${cand.text}」已经搁了一阵、快要从 working memory 淡出了。`
      + `如果此刻时机合适、且这阵子没提过,就用你自己的话温和地问一句要不要现在推进;`
      + `如果刚提过、或此刻打扰他不合适,就轻轻放过,不要硬提。绝不擅自替他做决定。）`
  const msg = await buildUserMessage(nudge, 'soul')
  try {
    agent.followup(msg)
    return 'fired'
  } catch {
    return 'followup-threw'
  }
}

/** Minimal apply() against a real host dir, to (re)generate the dashboard offline. */
function viewRunner(home) {
  let dash = ''
  apply({
    profileContext: { home },
    effect: (fn) => { fn(); return () => {} },
    systemPrompt: { context: () => () => {}, section: () => () => {} },
    tools: { register: () => {} },
    on: () => () => true,
    inject: () => false,
  })
  dash = DASH
  writeDashboard()
  return { dir: DIR, dashboard: dash }
}

export function apply(ctx) {
  const home = (ctx.profileContext && ctx.profileContext.home) || process.env.DSH_HOME || join(homedir(), '.dsh')
  DIR = join(home, 'soul')
  FACTS = join(DIR, 'facts.md')
  LOOPS = join(DIR, 'loops.md')
  NOTES = join(DIR, 'notes.md')
  PERSONA = join(DIR, 'persona.md')
  DONE = join(DIR, 'loops.done.md')
  FADED = join(DIR, 'facts.faded.md')
  DASH = join(DIR, 'dashboard.html')
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true })
  // Load user-tuned curve/hook settings BEFORE any decay math runs, so this boot (and the sweep
  // below) already reflects the latest prefs.json. applyCfg() mutates the module-scope CFG vars
  // that every curve/hook helper closes over, so a settings-page save takes effect on the next turn.
  PREFS_FILE = join(DIR, 'prefs.json')
  applyCfg(loadPrefs())
  // Forget a little on every load: archive stale, never-reinforced memories off the live files.
  const fadedNow = sweep()

  // 1. Per-turn recall: a context block, re-evaluated every assembly, so edits show up next turn.
  //    ctx.effect(fn) runs fn now and treats its return (a disposer) as the cleanup — so fn must
  //    be a thunk that returns the disposer, not the disposer itself (passing the disposer would
  //    unregister it immediately).
  ctx.effect(() => ctx.systemPrompt.context({
    name: 'soul:recall',
    order: 900,
    required: true,
    text: () => renderRecall(),
  }))

  // 2. Behavior guidance: static persona-level instruction about being a keeper of memory.
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'soul:guidance',
    order: 900,
    text: GUIDANCE,
  }))

  // 3. Curation tools.
  ctx.tools.register({
    name: 'soul_remember',
    description:
      'Persist one durable thing across all sessions. Use it the moment the user reveals a fact worth '
      + 'long-term memory (a birthday, a preference, a relationship, a standing request) or an unfinished '
      + 'matter you should keep in mind — even if it is a single passing sentence. kind: "fact" (about him) '
      + 'or "loop" (something to act on). Stored as plain markdown the user can read and edit.',
    parameters: {
      content: { type: 'string', description: 'The thing to remember, one concise line.' },
      kind: { type: 'string', description: '"fact" (default) or "loop" (a thing to proactively help with).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'kind', 'items', 'reinforced'],
        properties: { ok: { type: 'boolean' }, kind: { type: 'string' }, items: { type: 'integer' }, reinforced: { type: 'boolean' } },
      },
      render: (_a, v) => [{ type: 'text', text: `${v.reinforced ? '又印证' : '记住'}(${v.kind}):共 ${v.items} 条。` }],
    },
    async execute(args) {
      const content = typeof args.content === 'string' ? args.content.trim() : ''
      if (!content) throw new Error('soul_remember: content 不能为空')
      const kind = args.kind === 'loop' ? 'loop' : 'fact'
      const r = kind === 'loop' ? remember(LOOPS, HEADERS.loop, content, 'loop') : remember(FACTS, HEADERS.fact, content, 'fact')
      return { ok: true, kind, items: r.items, reinforced: r.reinforced }
    },
    presentCall: () => ({ card: 'generic', title: '记一笔', kind: 'other' }),
  })

  ctx.tools.register({
    name: 'soul_forget',
    description:
      'Delete memory lines whose text contains a substring, across facts, loops and notes. Use when the '
      + 'user says to forget something or stops wanting it remembered. Returns how many lines were removed.',
    parameters: {
      match: { type: 'string', description: 'Substring; every bullet containing it is removed.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'removed'],
        properties: { ok: { type: 'boolean' }, removed: { type: 'integer' } },
      },
      render: (_a, v) => [{ type: 'text', text: `删除了 ${v.removed} 条记忆。` }],
    },
    async execute(args) {
      const match = typeof args.match === 'string' ? args.match : ''
      if (!match) throw new Error('soul_forget: match 不能为空')
      let removed = 0
      for (const file of [FACTS, LOOPS, NOTES]) {
        if (!existsSync(file)) continue
        const lines = readFileSync(file, 'utf8').split('\n')
        const kept = []
        for (const line of lines) {
          if (/^\s*-\s+\S/.test(line) && line.includes(match)) { removed += 1; continue }
          kept.push(line)
        }
        if (removed > 0) writeFileSync(file, kept.join('\n'), 'utf8')
      }
      return { ok: true, removed }
    },
    presentCall: () => ({ card: 'generic', title: '忘掉', kind: 'other' }),
  })

  ctx.tools.register({
    name: 'soul_close_loop',
    description:
      'Mark an open loop as finished: moves every loop line containing the substring out of loops.md into an '
      + 'archive. Use once you have actually delivered on something you were keeping in mind.',
    parameters: {
      match: { type: 'string', description: 'Substring identifying the loop bullet(s) to close.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'closed'],
        properties: { ok: { type: 'boolean' }, closed: { type: 'integer' } },
      },
      render: (_a, v) => [{ type: 'text', text: `收掉了 ${v.closed} 件事。` }],
    },
    async execute(args) {
      const match = typeof args.match === 'string' ? args.match : ''
      if (!match) throw new Error('soul_close_loop: match 不能为空')
      const remaining = []
      const closed = []
      const lines = existsSync(LOOPS) ? readFileSync(LOOPS, 'utf8').split('\n') : []
      for (const line of lines) {
        if (/^\s*-\s+\S/.test(line) && line.includes(match)) closed.push(line)
        else remaining.push(line)
      }
      if (closed.length > 0) {
        const stamp = new Date().toISOString().slice(0, 10)
        appendFileSync(DONE, `\n${closed.map((l) => l.trimEnd() + `  ✓${stamp}`).join('\n')}`, 'utf8')
        writeFileSync(LOOPS, remaining.join('\n'), 'utf8')
      }
      return { ok: true, closed: closed.length }
    },
    presentCall: () => ({ card: 'generic', title: '收事', kind: 'other' }),
  })

  ctx.tools.register({
    name: 'soul_write',
    description:
      'Overwrite one whole memory file with curated markdown. This is how you digest memory: merge the '
      + 'scattered dated bullets in notes into clean facts/loops, prune stale entries, or store the user\'s '
      + 'style persona (e.g. the output of persona_distill) into persona.md so it is recalled every turn. '
      + 'file is one of "facts" | "loops" | "notes" | "persona". Content REPLACES the file.',
    parameters: {
      file: { type: 'string', description: 'facts | loops | notes | persona' },
      content: { type: 'string', description: 'The full new markdown body for that file.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'file', 'items'],
        properties: { ok: { type: 'boolean' }, file: { type: 'string' }, items: { type: 'integer' } },
      },
      render: (_a, v) => [{ type: 'text', text: `已重写 ${v.file}:共 ${v.items} 条。` }],
    },
    async execute(args) {
      const target = { facts: FACTS, loops: LOOPS, notes: NOTES, persona: PERSONA }[args.file]
      if (!target) throw new Error('soul_write: file 必须是 facts|loops|notes|persona')
      if (typeof args.content !== 'string') throw new Error('soul_write: content 必须是字符串')
      if (args.content.length > 24000) throw new Error('soul_write: content 过长(>24000 字符)')
      writeFileSync(target, args.content.endsWith('\n') ? args.content : args.content + '\n', 'utf8')
      return { ok: true, file: args.file, items: countItems(args.content) }
    },
    presentCall: () => ({ card: 'generic', title: '整理记忆', kind: 'other' }),
  })

  ctx.tools.register({
    name: 'soul_list',
    description:
      'Read the full current memory store (facts, loops, persona, notes), the directory it lives in, the '
      + 'faded archive, and a JSON decay curve (per-item retention %) so you can see what is about to be '
      + 'forgotten. The recall block already shows the live items each turn; use this when you need the '
      + 'untruncated text or the forgetting-curve state.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['facts', 'loops', 'persona', 'notes', 'faded', 'curve', 'dir'],
        properties: {
          facts: { type: 'string' },
          loops: { type: 'string' },
          persona: { type: 'string' },
          notes: { type: 'string' },
          faded: { type: 'string' },
          curve: { type: 'string' },
          dir: { type: 'string' },
        },
      },
      render: (_a, v) => [{ type: 'text', text: `记忆目录 ${v.dir}:事实 ${countItems(v.facts)} 条 / 待办 ${countItems(v.loops)} 件 / 已淡忘 ${countItems(v.faded)} 条。` }],
    },
    async execute() {
      const now = Date.now()
      const curve = computeState(now).map((it) => ({ text: it.text, kind: it.kind, n: it.n, R: Math.round(it.retention * 100) }))
      return {
        facts: read(FACTS), loops: read(LOOPS), persona: read(PERSONA), notes: read(NOTES),
        faded: existsSync(FADED) ? read(FADED) : '', curve: JSON.stringify(curve), dir: DIR,
      }
    },
    presentCall: () => ({ card: 'generic', title: '翻记忆', kind: 'other' }),
  })

  ctx.tools.register({
    name: 'soul_touch',
    description:
      'Reinforce a memory that you are actually using or that the user just re-confirmed, by a text '
      + 'substring. Each touch grows its stability (the forgetting curve flattens), so things that keep '
      + 'mattering stop fading. Use it when you act on / rely on a remembered fact.',
    parameters: {
      match: { type: 'string', description: 'Substring of the memory to reinforce.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'touched', 'reviews', 'retention'],
        properties: { ok: { type: 'boolean' }, touched: { type: 'boolean' }, reviews: { type: 'integer' }, retention: { type: 'integer' } },
      },
      render: (_a, v) => [{ type: 'text', text: v.touched ? `已强化:共 ${v.reviews} 次印证,保持度 ${v.retention}%。` : '没找到匹配的记忆。' }],
    },
    async execute(args) {
      const match = typeof args.match === 'string' ? args.match.trim() : ''
      if (!match) throw new Error('soul_touch: match 不能为空')
      const files = { [FACTS]: 'fact', [LOOPS]: 'loop', [NOTES]: 'note' }
      const kh = KIND_HEADER()
      for (const [file, kind] of Object.entries(files)) {
        const items = parseItems(file, kind)
        const it = items.find((i) => i.text.includes(match))
        if (!it) continue
        it.n += 1; it.review = today()
        writeItems(file, kh[kind], items)
        return { ok: true, touched: true, reviews: it.n, retention: Math.round(retention(it, Date.now()) * 100) }
      }
      return { ok: true, touched: false, reviews: 0, retention: 0 }
    },
    presentCall: () => ({ card: 'generic', title: '巩固记忆', kind: 'other' }),
  })

  ctx.tools.register({
    name: 'soul_dashboard',
    description:
      'Regenerate the self-contained memory visualization at ~/.dsh/soul/dashboard.html (forgetting curves, '
      + 'retention bars, and the raw memory files). Call it after curating memory if the user wants to look.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'path', 'items'],
        properties: { ok: { type: 'boolean' }, path: { type: 'string' }, items: { type: 'integer' } },
      },
      render: (_a, v) => [{ type: 'text', text: `可视化已生成:${v.path}(${v.items} 条)。` }],
    },
    async execute() {
      const n = writeDashboard()
      return { ok: true, path: DASH, items: n }
    },
    presentCall: () => ({ card: 'generic', title: '生成可视化', kind: 'other' }),
  })

  ctx.tools.register({
    name: 'soul_urge',
    description:
      'Schedule one agent-initiated continuation turn for after the current turn finishes — the generic '
      + '"event fired, keep the conversation going" bridge. Use it when something you were waiting on just '
      + 'returned a value and you want to act on it as its own follow-up (not this turn). The prompt is '
      + 'delivered to you on the next turn; it will not run if auto-continue is off or no agent is active.',
    parameters: {
      prompt: { type: 'string', description: 'What to pick up on the follow-up turn, phrased as a note to yourself.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['ok', 'queued'],
        properties: { ok: { type: 'boolean' }, queued: { type: 'boolean' } },
      },
      render: (_a, v) => [{ type: 'text', text: v.queued ? '已排入下一轮自动接续。' : '当前没有可接续的会话。' }],
    },
    async execute(args) {
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
      if (!prompt) throw new Error('soul_urge: prompt 不能为空')
      if (!AUTO_ON) return { ok: true, queued: false }
      const agents = ctx.agents
      const agent = agents && typeof agents.currentInitiator === 'function' ? agents.currentInitiator() : null
      if (!agent || typeof agent.followup !== 'function') return { ok: true, queued: false }
      const msg = await buildUserMessage(`（有灵·接续）${prompt}`, 'soul')
      try { agent.followup(msg); return { ok: true, queued: true } }
      catch { return { ok: true, queued: false } }
    },
    presentCall: () => ({ card: 'generic', title: '接续对话', kind: 'other' }),
  })

  // 4. Proactive auto-continue. On an 'idle' transition with a loop quietly nearing fade, fire ONE
  //    agent-initiated turn so the keeper can raise it unprompted. Guarded by cooldown + per-session
  //    seen-set inside surfaceRipeLoop; wrapped so nothing here can ever throw into the bus dispatch.
  //    Skipped when the host exposes no ctx.on (e.g. an offline view() run or a bare mock ctx).
  if (AUTO_ON && typeof ctx.on === 'function') {
    ctx.effect(() => ctx.on('agent/status', (evt) => {
      try {
        const out = surfaceRipeLoop(evt && evt.agent, Date.now())
        if (out && typeof out.catch === 'function') out.catch(() => {})
      } catch { /* never propagate into event dispatch */ }
    }))
  }

  // 5. Settings-page transport. The client page reads and writes prefs over this exact route,
  //    mirroring the persona-distill pattern. GET returns prefs with the API key masked plus a
  //    freshly-cached balance (never the key itself); PUT saves. Skipped on hosts without the
  //    webServer service or without ctx.inject (offline view() runs, bare mocks).
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => {
      const server = webCtx.get('webServer')
      if (!server) return
      webCtx.effect(() => server.register({
        kind: 'exact',
        path: '/soul/prefs',
        handler: async (req, res) => {
          const json = (status, payload) => {
            res.writeHead(status, {
              'Content-Type': 'application/json; charset=utf-8',
              'Cache-Control': 'no-store',
              'X-Content-Type-Options': 'nosniff',
            })
            res.end(JSON.stringify(payload))
          }
          const masked = () => {
            const p = { ...PREFS }
            p.deepseekApiKey = API_KEY_PREF ? '****' + API_KEY_PREF.slice(-4) : ''
            return p
          }
          if (req.method === 'GET' || req.method === 'HEAD') {
            if (Date.now() - balanceCache.at >= BALANCE_TTL) await fetchBalance()
            json(200, {
              prefs: masked(),
              hasKey: Boolean(API_KEY_PREF || resolveApiKey()),
              path: PREFS_FILE,
              balance: balanceCache.ok ? balanceCache.value : null,
              balanceCurrency: balanceCache.currency || null,
              balanceError: balanceCache.ok ? null : balanceCache.error,
            })
            return
          }
          if (req.method !== 'PUT' && req.method !== 'POST') {
            res.writeHead(405, { Allow: 'GET, HEAD, PUT, POST' }).end()
            return
          }
          let body = ''
          let tooBig = false
          req.on('data', (chunk) => {
            body += chunk
            if (body.length > 256 * 1024) { tooBig = true; req.destroy() }
          })
          req.on('end', async () => {
            if (tooBig) return
            try {
              const parsed = JSON.parse(body)
              // A masked echo from the page must not overwrite the stored key.
              if (typeof parsed.deepseekApiKey === 'string' && /\*/.test(parsed.deepseekApiKey)) delete parsed.deepseekApiKey
              const merged = savePrefs(parsed)
              applyCfg(loadPrefs())
              balanceCache = { value: null, currency: null, at: 0, ok: false, error: null }
              const p = { ...merged }
              p.deepseekApiKey = p.deepseekApiKey ? '****' + p.deepseekApiKey.slice(-4) : ''
              json(200, { prefs: p, hasKey: Boolean(merged.deepseekApiKey || resolveApiKey()) })
            } catch (error) {
              json(400, { error: `invalid preferences: ${error.message}` })
            }
          })
        },
      }), 'soul: prefs route')
    })
  }

  // Startup self-check (opt-in via SOUL_DEBUG=1): prove apply() ran against the REAL cordis
  // services without needing a model. Registers and immediately disposes one probe context to
  // confirm the ctx.systemPrompt.context disposer contract, then reports what loaded. Silent by
  // default so normal boots stay quiet.
  if (process.env.SOUL_DEBUG) {
    try {
      const disposer = ctx.systemPrompt.context({ name: 'soul:__probe', order: 1, required: true, text: () => 'p' })
      const disposerIsFn = typeof disposer === 'function'
      if (disposerIsFn) disposer()
      const recall = renderRecall()
      const route = typeof ctx.inject === 'function' ? 'on' : 'off'
      console.error(`[soul] loaded; tools=8 hook=${AUTO_ON && typeof ctx.on === 'function' ? (AUTO_ACT ? 'act' : 'ask') : 'off'} route=${route} guard=${BALANCE_GUARD_ENABLED ? 'on(¥' + BALANCE_FLOOR + ')' : 'off'} fade=${FADE} prune=${PRUNE} grace=${MIN_KEEP}d horizon=${AUTO_HORIZON}d cooldown=${AUTO_COOLDOWN}ms fadedThisBoot=${fadedNow} probeContextDisposer=${disposerIsFn} recallLen=${recall.length} dir=${DIR}`)
    } catch (e) {
      console.error('[soul] STARTUP SELF-CHECK FAILED: ' + (e && e.stack ? e.stack : e))
    }
  }
}

/**
 * Public offline entry: regenerate the memory dashboard against a real home dir without the app,
 * reusing this module's own curve math + template (single source of truth). Returns the dir and the
 * dashboard path so a launcher (the SoulView.exe viewer) can open it.
 */
export function view(home) {
  return viewRunner(home || process.env.DSH_HOME || join(homedir(), '.dsh'))
}
