# Context and Usage Monitor for Claude Code

A VS Code status bar extension that reads your local [Claude Code](https://code.claude.com/docs/en/claude-code)
transcript files (`~/.claude/projects/**/*.jsonl`) and shows accurate,
real-time context-window usage, cache hit rate, and cost. On a Claude
subscription (Pro/Max/Team) it also shows your 5-hour and weekly rate-limit
gauges (`5h:34% · w:53%`) — the limits that actually govern a subscription,
where dollars don't. Transcript-derived numbers stay fully offline; the
rate-limit gauges are the one deliberate, disclosable exception — see
[Network access](#network-access) below.

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
  status bar (`5h:34% · w:53%`), on by default — see
  [Network access](#network-access). Silently absent on API-key/Bedrock/
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
| `rateLimits.refreshSeconds` | `120` | How often the gauges refresh from the network (30–3600s). Shared across all open windows via a local cache file, so this isn't multiplied per window. |
| `rateLimits.showWeekly` | `true` | Show the weekly (`w:`) gauge alongside the 5-hour one. |
| `rateLimits.showPerModelWeekly` | `false` | Show per-model weekly gauges (Opus/Sonnet) in the tooltip, when your plan reports them (Max only). |
| `rateLimits.colorThresholds` | `{"warning":80,"error":90}` | Thresholds for `statusBar.colorMode: "rateLimit"`. |

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
- At most one request per `rateLimits.refreshSeconds` **per machine**,
  shared across every open VS Code window through a local cache file
  (`~/.claude/.context-usage-monitor/rate-cache.json`) — opening more
  windows doesn't multiply the request rate.
- No telemetry, no third-party endpoint, nothing beyond the two Anthropic
  URLs above. The token itself never appears in the tooltip, "Copy
  Diagnostics" output, or any cache file.
- Turn it off entirely with `contextUsageMonitor.rateLimits.enabled: false`.

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
