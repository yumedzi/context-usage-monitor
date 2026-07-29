# Changelog

## 0.2.0

- Added 5-hour/weekly subscription rate-limit gauges (`5h:34% · w:53%`) to
  the status bar, on by default (`rateLimits.enabled`). This reintroduces
  rate-limit tracking via a different mechanism than the one removed in
  0.1.0 below: instead of depending on Claude Code's `statusLine` hook (which
  the VS Code panel doesn't invoke), it calls Anthropic's
  `/api/oauth/usage` and `/api/oauth/profile` endpoints directly, using the
  same local OAuth token Claude Code already stores on disk. This works from
  the panel regardless of whether a terminal session is running. See the
  README's new **Network access** section for exactly what this sends and
  when — it's the one part of this extension that isn't fully offline, and
  it's disclosed and toggleable.
- Silently hidden on API-key/Bedrock/Vertex/Foundry billing, where 5-hour/
  weekly limits don't apply.
- New `statusBar.colorMode: "rateLimit"` background-color policy and
  `rateLimits.colorThresholds` setting.
- New tooltip section `rateLimits` (session/weekly percentages, reset
  countdowns, plan name), and a new **Refresh Rate Limits Now** command.
- New settings: `rateLimits.enabled`, `rateLimits.refreshSeconds`,
  `rateLimits.showWeekly`, `rateLimits.showPerModelWeekly`,
  `rateLimits.colorThresholds`.

## 0.1.0

Initial release.

- Correct context-window sizes and pricing from a built-in, offline model
  registry — no network fetch, no scraper to go stale.
- Model resolution never silently guesses: an unrecognized model id shows an
  explicit "unknown model" state instead of a plausible-but-wrong 200K/`$?`.
- `<synthetic>` and other zero-token bookkeeping records are excluded from
  context and cost tracking.
- Correct workspace-to-transcript matching for paths containing `.` or `_`,
  verified against each record's own `cwd` field.
- 5-minute vs. 1-hour cache-write pricing tracked and charged separately.
- Configurable status bar segments, tooltip sections, per-model pricing
  overrides, and context-window overrides.
- Local, machine-scoped monthly usage total with a configurable billing-cycle
  start day.
- Commands: Show Usage Report, Recalculate Monthly Usage, Open Anthropic
  Pricing Page, Copy Diagnostics.
- Reasoning-effort level (low/medium/high) shown after the model name when
  Claude Code recorded one, toggleable via `statusBar.showEffort`.
- Month-to-date cost as an always-visible (including while idle) status bar
  segment, off by default (`statusBar.showMonthlyCost`).
- Status bar separator is now just a character (default `·`), with spacing
  applied automatically.
- Fixed: the model segment now shows the resolved registry name (e.g.
  `haiku-4-5`) instead of the raw dated snapshot id (e.g.
  `haiku-4-5-20251001`) whenever the id resolves.
- Removed the subscription/API plan-type distinction (and the `~`
  API-equivalent cost prefix that came with it) — costs are shown plainly.
- Removed 5-hour/weekly rate-limit tracking: Claude Code only exposes that
  data through its `statusLine` hook, which the VS Code extension panel does
  not appear to invoke (confirmed: no cache writes across multiple real
  turns) — so the feature only ever worked from an actual terminal session,
  not from the panel this extension is meant to complement. Not worth the
  complexity of a bridge script that modifies global Claude Code config for
  a payoff that doesn't apply to the primary use case.
