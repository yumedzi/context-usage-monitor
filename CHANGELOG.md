# Changelog

## 0.1.0 — Unreleased

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
