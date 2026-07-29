# Context and Usage Monitor for Claude Code

A VS Code status bar extension that reads your local [Claude Code](https://code.claude.com/docs/en/claude-code)
transcript files (`~/.claude/projects/**/*.jsonl`) and shows accurate,
real-time context-window usage, cache hit rate, and cost. On a Claude
subscription (Pro/Max/Team) it also shows your 5-hour and weekly rate-limit
gauges (`5h:34% · w:53%`) — the limits that actually govern a subscription,
where dollars don't. These gauges update **the moment Claude Code finishes a
turn**, not on a blind polling schedule — see
[How the rate-limit gauges stay fresh](#how-the-rate-limit-gauges-stay-fresh)
below. Transcript-derived numbers stay fully offline; the rate-limit gauges
are the one deliberate, disclosable exception — see
[Network access](#network-access).

> **Not affiliated with, endorsed by, or sponsored by Anthropic.** This is an
> independent, community-built tool. "Claude Code" is referenced only to
> describe compatibility.

## Why this exists

This project started as a rewrite of
[claude-cache-watcher](https://github.com/shivaraj-arch/claude-cache-watcher)
by Shivaraj (MIT licensed — see [LICENSE-THIRD-PARTY.md](LICENSE-THIRD-PARTY.md)),
after running into a few real bugs:

- **Wrong context window.** A model-resolution bug caused Claude Sonnet 5 to
  silently fall back to a 200K window instead of its real 1M, with cost
  shown as `$?`.
- **`<synthetic>` in the status bar.** Claude Code writes local zero-token
  bookkeeping records (e.g. "No response requested.") tagged with the model
  id `<synthetic>`. Counting them tanked the cache-hit reading to 0% and
  painted the status bar item black.
- **Broken workspace scoping.** Claude Code encodes a project's path into its
  transcript directory name by replacing `/`, `.`, *and* `_` with `-`. The
  original only replaced `/`, so any path containing a dot or underscore
  (e.g. `claude_context_monitor`) would silently fall back to showing
  whichever project's transcript was touched most recently — not necessarily
  the current one.
- **Cache-write pricing conflation.** 5-minute and 1-hour cache writes are
  priced differently (1.25x vs. 2x input token price) but only one rate was
  ever tracked.
- **Network-fetched pricing.** Pricing was scraped from a marketing page at
  runtime, which is exactly what caused the model-resolution bug above.
  Pricing here is a built-in, offline table you can override in settings —
  this stays true even with rate-limit gauges enabled (see below); it's
  *pricing* that's offline, not literally everything the extension does.

This is a clean rewrite (not a fork) — see [CHANGELOG.md](CHANGELOG.md) for
what changed. Context, cache, and cost numbers are derived only from files
already on your disk. The 5-hour/weekly rate-limit gauges are the one
exception, described in full in [Network access](#network-access).

## Features

- Correct context-window % and token counts, per model, with no network call.
- An explicit "unknown model" state (never a silently wrong number) when a
  model isn't in the registry — add it yourself via `pricing.models`.
- Per-turn, per-session, and monthly-to-date cost, with separate 5m/1h
  cache-write pricing.
- A configurable local monthly spend total (see [Scope](#scope) below).
- On a subscription plan: 5-hour and weekly rate-limit gauges right in the
  status bar (`5h:34% · w:53%`), on by default. They refresh **the instant a
  new Claude Code turn is detected** — not on a fixed timer — so the number
  you see reflects what you actually just did, with a lightweight 15-minute
  backstop check purely so the gauge doesn't go stale if you leave the
  editor open and idle through a reset. See
  [How the rate-limit gauges stay fresh](#how-the-rate-limit-gauges-stay-fresh)
  and [Network access](#network-access). Silently absent on API-key/Bedrock/
  Vertex/Foundry billing, where these limits don't apply.
- Every status bar segment and tooltip section is independently toggleable.
- Commands: **Show Usage Report**, **Recalculate Monthly Usage**, **Open
  Anthropic Pricing Page**, **Copy Diagnostics** (for bug reports), **Refresh
  Rate Limits Now**.

## Settings

All settings live under `contextUsageMonitor.*`:

| Setting | Default | Description |
|---|---|---|
| `statusBar.enabled` | `true` | Show the status bar item. |
| `statusBar.alignment` | `right` | `left` or `right`. |
| `statusBar.priority` | `100` | Higher = further left/right within its alignment. |
| `statusBar.segments` | `["model","context","turnCost"]` | Ordered list from: `model`, `context`, `contextTokens`, `cacheHit`, `turnCost`, `sessionCost`, `idleState`. |
| `statusBar.separator` | `·` | Just the character — spaces are added automatically around it when rendering. |
| `statusBar.colorMode` | `none` | `none`, `cacheHit` (warn on low hit rate), `contextFill` (warn/error as context fills up), or `rateLimit` (warn/error as 5-hour/weekly usage climbs). |
| `statusBar.showIcon` | `true` | Show the leading icon. |
| `statusBar.showEffort` | `true` | Show the reasoning-effort level (low/medium/high) in parentheses after the model name, when Claude Code recorded one. |
| `statusBar.showMonthlyCost` | `false` | Show month-to-date cost, appended at the end. Renders even while idle — it's a background total, not tied to the current turn. |
| `tooltip.sections` | all | Ordered list from: `turn`, `context`, `cache`, `rateLimits`, `cost`, `monthly`, `links`. |
| `pricing.models` | `{}` | Per-model `input`/`output`/`cacheRead`/`cacheWrite5m`/`cacheWrite1h` ($/token) and `contextWindow` overrides, merged over the built-in defaults. |
| `pricing.currencySymbol` | `$` | Currency symbol for formatted costs. |
| `usage.billingCycleStartDay` | `1` | Day of month (1–28) your monthly total resets on. |
| `filters.modelPattern` | `^claude-` | Regex a model id must match to count at all. |
| `filters.includeSidechainsInContext` | `false` | Include subagent turns in the context gauge (they always count toward cost). |
| `contextWindowOverrides` | `{}` | Shortcut for `pricing.models.<id>.contextWindow`. |
| `rateLimits.enabled` | `true` | Show the 5-hour/weekly gauges. Makes a network request — see [Network access](#network-access). |
| `rateLimits.refreshSeconds` | `900` (15 min) | Minimum interval between network checks (30–3600s) — the floor below which the on-new-turn trigger won't re-fetch, and the scheduled backstop's own interval. |
| `rateLimits.scheduledCheckEnabled` | `true` | Also check on a `refreshSeconds` schedule, in addition to checking on every new turn. Turn off for zero idle-time network use — see [How the rate-limit gauges stay fresh](#how-the-rate-limit-gauges-stay-fresh). |
| `rateLimits.showWeekly` | `true` | Show the weekly (`w:`) gauge alongside the 5-hour one. |
| `rateLimits.showPerModelWeekly` | `false` | Show per-model weekly gauges (Opus/Sonnet) in the tooltip, when your plan reports them (Max only). |
| `rateLimits.colorThresholds` | `{"warning":80,"error":90}` | Thresholds for `statusBar.colorMode: "rateLimit"`. |

## How the rate-limit gauges stay fresh

Most extensions that show this kind of thing poll on a fixed timer — showing
a number that's up to `N` seconds stale even while you're actively working,
and still polling every `N` seconds even when you've stepped away and
nothing is happening. This one is event-driven instead:

- **On every new turn.** The same lightweight transcript scan this extension
  already does every 10 seconds to update context/cost also notices when a
  genuinely new Claude Code record has appeared. The instant it does, the
  rate-limit gauge refreshes — so right after you finish a turn, the number
  you see is the number that turn actually produced, not a stale reading
  from up to `refreshSeconds` ago.
- **A 15-minute backstop, not the main driver.** `rateLimits.refreshSeconds`
  (default `900` = 15 min) now exists only to catch the case where you leave
  the editor open and idle for a long stretch spanning a 5-hour or weekly
  reset — with no new turn to trigger a check, the gauge would otherwise
  keep showing a stale percentage indefinitely. Set
  `rateLimits.scheduledCheckEnabled: false` to disable this entirely: the
  gauge then updates *only* when you're actually using Claude Code, at the
  cost of possibly showing a stale number if a window resets while you're
  away.
- **Both paths share one safety net.** Whichever one fires, the actual
  network call still only happens if the on-disk cache is older than
  `refreshSeconds` — a burst of records from one busy agentic turn (many
  tool calls in a row) can trigger the check repeatedly without causing a
  burst of requests; it just resolves from cache until the interval is
  actually up.

Net effect: on a typical active session, this is *more* responsive than a
120s timer ever was, while making meaningfully fewer requests overall —
during any stretch where you're not generating new turns, it makes none.

## Network access

Everything above — context, cache, and cost — comes only from files already
on disk. The 5-hour/weekly rate-limit gauges are the one exception:

- Two `GET` requests to `api.anthropic.com` (`/api/oauth/usage` and
  `/api/oauth/profile`), using the **same local Claude Code OAuth token**
  Claude Code itself already stores (in `~/.claude/.credentials.json` or the
  macOS Keychain) — no separate API key, no new credential.
- Only fires when you're on a **subscription** plan (Pro/Max/Team/Enterprise
  via Claude.ai login). If Claude Code is configured for API-key, Bedrock,
  Vertex, or Foundry billing, the request is never made and the gauges are
  silently hidden — those don't have 5-hour/weekly limits.
- Triggered by a new turn or the 15-minute backstop (see above), but never
  more than once per `rateLimits.refreshSeconds` **per machine**, shared
  across every open VS Code window through a local cache file
  (`~/.claude/.context-usage-monitor/rate-cache.json`) — opening more
  windows doesn't multiply the request rate.
- No telemetry, no third-party endpoint, nothing beyond the two Anthropic
  URLs above. The token itself never appears in the tooltip, "Copy
  Diagnostics" output, or any cache file.
- Turn it off entirely with `contextUsageMonitor.rateLimits.enabled: false`,
  or keep the gauges but drop the idle-time backstop with
  `rateLimits.scheduledCheckEnabled: false`.

## Scope

Monthly usage is computed **locally**, by scanning your own
`~/.claude/projects` directory on this machine — it does not require, and
does not use, an Anthropic Admin API key, and it cannot see usage from other
machines or other members of an organization. If you work across multiple
machines, each one tracks its own total.

## Installing

Not yet published to a marketplace. To try it locally:

1. Download the `.vsix` file.
2. In VS Code: Extensions view → `...` menu → **Install from VSIX...**

## License

[MIT](LICENSE) © 2026 Viktor Moyseyenko. Third-party notices in
[LICENSE-THIRD-PARTY.md](LICENSE-THIRD-PARTY.md).
