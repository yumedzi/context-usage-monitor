# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A VS Code extension (status bar item) that reads local Claude Code transcript
files (`~/.claude/projects/**/*.jsonl`) and shows context-window usage, cache
hit rate, and cost — entirely offline except for one deliberate exception:
fetching 5-hour/weekly subscription rate-limit gauges from
`api.anthropic.com` using the same OAuth token Claude Code itself stores.
Not affiliated with Anthropic. See [README.md](README.md) for full
user-facing behavior and settings documentation — don't duplicate it here.

This is a rewrite of `claude-cache-watcher` specifically to fix bugs in that
project (wrong context window, `<synthetic>` records polluting stats, broken
workspace path encoding, cache-write mispricing, network-fetched pricing).
When touching related code, check the "Why this exists" section of the
README — those bugs are exactly the regressions to avoid reintroducing.

## Commands

```bash
npm run compile   # tsc --noEmit type check
npm run lint      # eslint src test
npm test          # vitest run (unit tests only, no VS Code host needed)
npm run build     # esbuild bundle to dist/extension.js
npm run package   # compile + lint + test + production build + vsce package
```

Run a single test file: `npx vitest run test/resolve.test.ts`
Run tests matching a name: `npx vitest run -t "cwdMatchesWorkspace"`

There is no VS Code integration-test harness — `src/core/*` is pure,
VS-Code-API-free logic and is exercised directly by vitest under Node. Files
outside `src/core` (`extension.ts`, `statusBar.ts`, `tooltip.ts`,
`settings.ts`) import `vscode` and are not unit tested; verify changes to
those manually via VSIX install (`vsce package` then "Install from VSIX...").

## Architecture

**`src/core/*` is pure and side-effect-light (fs reads only, no `vscode`
import)** — this is the testable core, and new logic should live there
rather than in `extension.ts` when at all possible.

- `transcript.ts` — parses a single JSONL line into a `UsageRecord`,
  filtering out non-Claude/synthetic records via `modelPattern`.
- `resolve.ts` — resolves a raw model id (possibly a dated snapshot id like
  `claude-haiku-4-5-20251001`) against the pricing registry. Never guesses:
  returns `null` on a genuine miss so callers can render an explicit
  "unknown model" state rather than a silently wrong number.
- `models.ts` / `pricing.ts` — built-in offline pricing/context-window
  table and cost math (separate 5m vs 1h cache-write rates).
- `workspace.ts` — encodes a workspace path into Claude Code's project
  directory naming scheme (`replace(/[/._]/g, '-')`) and independently
  verifies the match against the transcript's own `cwd` field, since the
  encoding scheme is a guess that could change upstream but `cwd` is
  authoritative.
- `usage.ts` — incremental monthly cost aggregation across all project
  directories, caching per-file byte offsets and per-record dedupe keys so
  repeat scans only read newly appended bytes.
- `credentials.ts` — reads Claude Code's own OAuth token from
  `~/.claude/.credentials.json` or the OS keychain.
- `usageApi.ts` — fetches rate-limit data from `api.anthropic.com`, with a
  TTL-gated on-disk cache (`~/.claude/.context-usage-monitor/rate-cache.json`)
  shared across all open VS Code windows so multiple windows never multiply
  the request rate.
- `rateLimits.ts` — types/shaping for the rate-limit snapshot.
- `format.ts` — small display-formatting helpers.

**`src/extension.ts`** is the VS Code entry point and orchestrator: owns all
module-level mutable state (`currentState`, `currentRates`, etc.), the
polling timers (10s turn refresh, 60s monthly refresh, rate-limit timer),
and wires core functions together into `render()`, which feeds both
`statusBar.ts` (the status bar item) and `tooltip.ts` (the hover markdown).
Registered commands (`showReport`, `recalculateMonthly`, `openPricingPage`,
`copyDiagnostics`, `refreshRateLimits`) live here.

**Rate-limit refresh has two independent triggers feeding one TTL-gated
function** (`refreshRateLimits` in `extension.ts`, gated inside
`usageApi.fetchRateLimits`): a turn-detection trigger
(`maybeTriggerRateLimitRefresh`, fires the instant a new transcript record
appears) and a scheduled backstop timer (`startRateTimer`, catches a
rate-limit window resetting during a long idle stretch). Neither can exceed
one network round-trip per `rateLimits.refreshSeconds` per machine — preserve
that invariant when modifying either path.

**`settings.ts`** reads and validates `contextUsageMonitor.*` VS Code
configuration into a typed `ExtensionConfig`, and merges user
`pricing.models` overrides into the built-in registry (`buildRegistry`).

**`types.ts`** holds the cross-module state shapes (`MonitorState`,
`TurnSnapshot`, `WorkspaceDiagnostics`, etc.) shared between `extension.ts`,
`statusBar.ts`, and `tooltip.ts`.

## Conventions worth preserving

- No network calls anywhere in `src/core` except `usageApi.ts` — that
  boundary is a deliberate, documented exception (see README's "Network
  access" section), not an oversight to "fix" by adding more.
- Prefer explicit "unknown"/`null` states over falling back to a plausible-
  but-wrong default (this is the core lesson from the bugs this project was
  rewritten to fix — see `resolve.ts`'s doc comment for the canonical
  example).
- Test fixtures for transcript parsing live in `test/fixtures/*.jsonl`
  (e.g. `synthetic.jsonl`, `dated-model.jsonl`, `dedupe.jsonl`) — add new
  edge cases as fixtures there rather than inlining large JSONL strings in
  test files.
