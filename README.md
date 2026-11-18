# 有灵 · soul — cross-session memory for the DeepSeek Harness

> A DSH (DeepSeek Harness) plugin that makes the agent behave like a person who
> remembers: it keeps durable memory on disk, re-surfaces it every turn, **forgets
> slowly** along an Ebbinghaus curve, and can **re-raise an abandoned task on its
> own** when a session goes idle — gated so it never silently spends your API credit.

All memory is **plain markdown** under `<home>/soul/` that you can read, edit, or
delete by hand at any time. There is no hidden database and no background model call.

---

## What it does

1. **Per-turn recall** — every user turn, a context block of live memories is
   injected so the agent can reference them across sessions.
2. **Proactive remembering** — guidance nudges the agent to call `soul_remember`
   when you mention something worth keeping (a birthday, a preference, an
   unfinished task) without being told to.
3. **Forgetting curve** — each line carries created/review/review-count metadata;
   retention decays with age, so stale, never-reinforced memories fade out of
   recall and eventually archive — *forget into files, not delete*.
4. **Auto-continue hook** — when a session goes idle and a "task you're holding on
   to" (`loops`) is close to fading, the agent wakes itself to carry it out
   (auto-act) or ask whether to (ask-only). A **balance floor** stops the hook from
   firing when your DeepSeek balance is low.
5. **Settings page** — tune every knob under **Settings → 有灵 · 记忆**; a saved
   change applies on the next turn, no restart.

---

## Install

### DSH Desktop

1. Add the package to the profile as a git dependency and a bundle:

   ```jsonc
   // ~/.dsh/profiles/desktop/package.json
   {
     "dependencies": {
       "dsh-soul": "github:Tatsukini/Tatsukini-dsh-soul"
     },
     "dsh": {
       "profile": {
         "bundles": [
           "@deepseek-ai/dsh-base",
           "@deepseek-ai/dsh-web-app",
           "dsh-soul"
         ]
       }
     }
   }
   ```

2. Restart the desktop profile. Plugins apply at boot, so a page refresh is not
   enough — the bundle list and the client module manifest are recomputed on
   process start.
3. Open **Settings → 有灵 · 记忆**. The section only appears once the client module
   is loaded (this package declares `dsh.client.inject: ["@deepseek-ai/dsh-client-ui-settings"]`).

### Headless / CLI

Point any non-`desktop` profile's bundle list at `dsh-soul` the same way and run a
turn; the host side (recall, guidance, tools, hook) works without the web client.

---

## Memory layout

Written under `<home>/soul/` (`<home>` = the DSH profile home, normally `~/.dsh`):

| file | holds |
|---|---|
| `facts.md` | durable facts (person, preferences, environment) |
| `loops.md` | open commitments / abandoned tasks the hook re-raises |
| `notes.md` | passing observations, lowest retention |
| `persona.md` | language/style tags (never decays) |
| `loops.done.md` | closed loops archive |
| `facts.faded.md` | pruned, low-retention items (still recoverable) |
| `prefs.json` | settings saved from the page |
| `dashboard.html` | generated decay-curve visualization |

Each memory line embeds metadata as an HTML comment (`c`=created, `r`=last review,
`n`=review count, `k`=kind). The recall block **strips** it — no dates or tags leak
into the model context.

---

## Tools (8)

| tool | purpose |
|---|---|
| `soul_remember` | store a fact/loop/note/persona line (dedup reinforces existing) |
| `soul_forget` | remove a line by match |
| `soul_close_loop` | mark a loop done → archive to `loops.done.md` |
| `soul_write` | agent curates its own store (digest notes, write persona) |
| `soul_list` | list current memory, with decay/retention detail |
| `soul_touch` | review-without-rewrite: bump a line's review count (reinforces it) |
| `soul_dashboard` | regenerate `dashboard.html` (and return its path) |
| `soul_urge` | event-driven bridge: enqueue a "continue now" nudge this turn |

---

## Forgetting curve

```
stability  S = baseDays[kind] * reviewMultiplier ^ (reviewCount - 1)   [days]
retention  R = exp(-ageDays / S)
```

- `baseDays` per kind (defaults: fact 120, loop 40, note 12, persona 3650).
- `persona` and anything inside the grace window are held at `R = 1`.
- `R < fadePercent` → excluded from recall ("can't think of it right now") but kept on disk.
- `R < prunePercent` **and** never reinforced → archived to `*.faded.md` on boot.
- Re-touching / re-remembering a line doubles its stability.

All of these (base days, review multiplier, fade %, prune %, grace days, recall
char cap) are sliders on the settings page.

---

## Auto-continue hook + balance guard

- On `agent/status → idle`, the hook picks the oldest live `loops` item that is
  within `autoHorizonDays` of fading and not yet raised this session.
- **Auto-act on** (`想起就去做`): the agent carries the task out directly. **Off:**
  it asks whether to. Either way, spending money, sending externally, deleting,
  leaving the workspace, or any irreversible action still prompts the user first.
- Guards: per-session seen-set, `autoCooldownSec` between firings, and the
  **balance floor** — a known DeepSeek balance below `balanceFloorYuan` (default
  ¥3) suppresses the hook. An unknown balance is allowed through (fail-open on the
  guard, never a silent block).

---

## Settings, route, and the API key

Host HTTP routes (registered through `webServer`): `GET/PUT /soul/prefs`,
`GET /soul/dashboard`. The page reads/writes these.

- The `deepseekApiKey` field only ever round-trips **masked** (`****` + last 4);
  echoing a masked value back preserves the stored key. Leave it blank to fall back
  to `DEEPSEEK_API_KEY`, then to a transient local read of the companion 梁文挂件
  config — the key is never written into recall or logs.
- Current balance is shown read-only on the page (¥).

Defaults (17 fields): `baseFactDays`, `baseLoopDays`, `baseNoteDays`,
`basePersonaDays`, `reviewMultiplier`, `fadePercent`, `prunePercent`, `graceDays`,
`maxRecallChars`, `autoEnabled`, `autoAct`, `autoHorizonDays`, `autoCooldownSec`,
`balanceGuardEnabled`, `balanceFloorYuan`, `balanceBaseUrl`, `deepseekApiKey`.

### Environment overrides

| var | effect |
|---|---|
| `SOUL_AUTO=0` | force the auto-continue hook off |
| `SOUL_AUTO_ACT=0` | force ask-only (no direct action) |
| `SOUL_BALANCE_GUARD=0` | disable the balance floor |
| `SOUL_LIANGWEN_CONFIG` | override the companion config path for key fallback |
| `SOUL_DEBUG=1` | self-check line on host load (not visible in the desktop launcher) |

---

## Reading your memory visually

Call `soul_dashboard` (the agent will, or ask it to) to regenerate
`<home>/soul/dashboard.html` — a self-contained page with each item's decay curve
and retention bars. To do it from a plain Node runtime without the app:

```bash
node tools/soul-view.mjs          # prints the dashboard path
```

A native double-click desktop viewer is a personal extra of the author's setup and is
intentionally **not** part of this package.

---

## Tests

Deterministic, no network, no live app required:

```bash
npm test
```

Covers the store + curve math, metadata write / recall-no-leak / dedup-reinforce /
sweep-archive, the idle→followup hook (ask + act modes), and the settings route
(GET mask / PUT clamp / key preservation / balance-block → allow-above-floor).

---

## Compatibility

Built against cordis 4 / DSH `0.2.1-rc.3`; `engines.dsh` is `>=0.2.1-rc.3`. The
client module relies on `@deepseek-ai/dsh-client-ui-settings` providing the
`settings.section` slot.

## Privacy & safety

- Memory lives on **your** disk only; nothing is uploaded by this plugin.
- The hook never performs external/irreversible actions without asking.
- The balance guard avoids burning API credit unprompted.

## License

MIT © 2026 Tatsukini
