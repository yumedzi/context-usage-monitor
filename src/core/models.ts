/**
 * Built-in model registry: pricing ($/token) and context window sizes.
 * No network access — the upstream extension scraped platform.claude.com,
 * which produced keys like "claude-sonnet-5-through-august-31,-2026" that
 * never match the plain "claude-sonnet-5" model id Claude Code sends. That
 * single miss caused both the wrong 200K context reading and the "$?" cost.
 *
 * Source: Anthropic pricing page, snapshot 2026-10-02. Kept in code (not
 * fetched) so it never silently degrades; users can override via the
 * `pricing.models` / `contextWindowOverrides` settings.
 *
 * Rules that hold for every entry (enforced by test/models.test.ts):
 *  - cache write 5m = 1.25x input, cache write 1h = 2x input
 *  - cache read = 0.1x input, except Opus 5.5 (0.05x) and Fable/Mythos 5.1 (0.025x)
 * Claude 4.6+ models have no long-context (>200K) premium. Older Sonnet 4.x
 * long-context premium is NOT modelled (see README).
 */

export interface ModelPricing {
  /** $ per input token */
  input: number;
  /** $ per output token */
  output: number;
  /** $ per cache-read token (0.1x input unless the model says otherwise) */
  cacheRead: number;
  /** $ per cache-write token, 5-minute TTL (1.25x input) */
  cacheWrite5m: number;
  /** $ per cache-write token, 1-hour TTL (2x input) */
  cacheWrite1h: number;
  /** context window size in tokens */
  contextWindow: number;
  /**
   * Multiplier applied to every token category when the turn ran in "fast"
   * mode (`usage.speed === "fast"`). Models without this field have no fast
   * mode, so a "fast" record is priced at the standard rate.
   */
  fastMultiplier?: number;
  /** optional time-boxed introductory pricing that supersedes the above (no built-in model currently uses it) */
  introPrice?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite5m: number;
    cacheWrite1h: number;
    /** ISO date (inclusive) after which introPrice no longer applies */
    until: string;
  };
}

// Documented cache-pricing multipliers, relative to input price.
export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_5M_MULTIPLIER = 1.25;
export const CACHE_WRITE_1H_MULTIPLIER = 2;

interface ModelOptions {
  /** cache-read multiplier relative to input (default 0.1) */
  cacheRead?: number;
  fastMultiplier?: number;
}

// All prices are $ per token (MTok price / 1_000_000).
const PER_MTOK = 1_000_000;
function fromMTok(inputPerMTok: number, outputPerMTok: number, contextWindow: number, opts: ModelOptions = {}): ModelPricing {
  const input = inputPerMTok / PER_MTOK;
  const entry: ModelPricing = {
    input,
    output: outputPerMTok / PER_MTOK,
    cacheRead: input * (opts.cacheRead ?? CACHE_READ_MULTIPLIER),
    cacheWrite5m: input * CACHE_WRITE_5M_MULTIPLIER,
    cacheWrite1h: input * CACHE_WRITE_1H_MULTIPLIER,
    contextWindow,
  };
  if (opts.fastMultiplier !== undefined) entry.fastMultiplier = opts.fastMultiplier;
  return entry;
}

export const DEFAULT_MODEL_REGISTRY: Record<string, ModelPricing> = {
  'claude-fable-5-1': fromMTok(10, 50, 1_000_000, { cacheRead: 0.025 }),
  'claude-mythos-5-1': fromMTok(10, 50, 1_000_000, { cacheRead: 0.025 }),
  'claude-fable-5': fromMTok(10, 50, 1_000_000),
  'claude-mythos-5': fromMTok(10, 50, 1_000_000),
  'claude-opus-5-5': fromMTok(4, 20, 1_000_000, { cacheRead: 0.05, fastMultiplier: 2 }),
  'claude-opus-5': fromMTok(5, 25, 1_000_000, { fastMultiplier: 2 }),
  'claude-opus-4-8': fromMTok(5, 25, 1_000_000, { fastMultiplier: 2 }),
  'claude-opus-4-7': fromMTok(5, 25, 1_000_000),
  'claude-opus-4-6': fromMTok(5, 25, 1_000_000),
  'claude-opus-4-5': fromMTok(5, 25, 1_000_000),
  'claude-opus-4-1': fromMTok(15, 75, 200_000),
  'claude-opus-4-0': fromMTok(15, 75, 200_000),
  'claude-sonnet-5-5': fromMTok(2, 10, 1_000_000),
  // Anthropic made $2/$10 permanent; the earlier "intro until 2026-08-31, then
  // $3/$15" schedule never took effect.
  'claude-sonnet-5': fromMTok(2, 10, 1_000_000),
  'claude-sonnet-4-6': fromMTok(3, 15, 1_000_000),
  'claude-sonnet-4-5': fromMTok(3, 15, 1_000_000),
  'claude-sonnet-4-0': fromMTok(3, 15, 200_000),
  'claude-haiku-4-5': fromMTok(1, 5, 200_000),
  'claude-3-5-haiku-20241022': fromMTok(0.8, 4, 200_000),
  'claude-3-haiku-20240307': fromMTok(0.25, 1.25, 200_000),
};

/**
 * Resolve the effective pricing for a model, honoring intro pricing at a
 * given point in time. `atISODate` may be a bare date ("2026-07-29") or a
 * full timestamp ("2026-07-29T14:03:00Z") — comparison is done on parsed
 * Date values (not string prefix matching) so the intro window's end date
 * is inclusive for its entire calendar day.
 */
export function effectivePricing(entry: ModelPricing, atISODate: string): Omit<ModelPricing, 'introPrice'> {
  if (entry.introPrice) {
    const at = new Date(atISODate).getTime();
    const untilEndOfDay = new Date(`${entry.introPrice.until}T23:59:59.999Z`).getTime();
    if (!Number.isNaN(at) && at <= untilEndOfDay) {
      const { until: _until, ...rest } = entry.introPrice;
      return { ...rest, contextWindow: entry.contextWindow };
    }
  }
  const { introPrice: _introPrice, ...rest } = entry;
  return rest;
}

/**
 * User override shape for `pricing.models.<id>`. Prices may be given either
 * per token (`input`, `output`, ...) or per million tokens (`inputPerMTok`,
 * `outputPerMTok`, `cacheReadPerMTok`, `cacheWrite5mPerMTok`,
 * `cacheWrite1hPerMTok`); the per-token field wins if both are set.
 */
export type PricingOverride = Partial<ModelPricing> & {
  inputPerMTok?: number;
  outputPerMTok?: number;
  cacheReadPerMTok?: number;
  cacheWrite5mPerMTok?: number;
  cacheWrite1hPerMTok?: number;
};

function pick(perToken: number | undefined, perMTok: number | undefined): number | undefined {
  if (typeof perToken === 'number') return perToken;
  if (typeof perMTok === 'number') return perMTok / PER_MTOK;
  return undefined;
}

/**
 * Apply a user override onto a (possibly missing) base entry.
 *
 * When the override changes `input` but not a cache rate, that cache rate is
 * re-derived from the new input (keeping the base's cache-read ratio, or the
 * standard 0.1x/1.25x/2x), instead of silently keeping a stale absolute rate
 * or — for a brand-new model — a free (0) one. Any intro price on the base
 * is dropped when a price field is overridden, since it would otherwise
 * silently supersede the user's number.
 */
export function applyPricingOverride(base: ModelPricing | undefined, override: PricingOverride): ModelPricing {
  const baseInput = base?.input ?? 0;
  const readRatio = base && base.input > 0 ? base.cacheRead / base.input : CACHE_READ_MULTIPLIER;

  const input = pick(override.input, override.inputPerMTok);
  const output = pick(override.output, override.outputPerMTok);
  const cacheRead = pick(override.cacheRead, override.cacheReadPerMTok);
  const cacheWrite5m = pick(override.cacheWrite5m, override.cacheWrite5mPerMTok);
  const cacheWrite1h = pick(override.cacheWrite1h, override.cacheWrite1hPerMTok);

  const newInput = input ?? baseInput;
  const rederive = input !== undefined;
  const priceOverridden =
    input !== undefined || output !== undefined || cacheRead !== undefined || cacheWrite5m !== undefined || cacheWrite1h !== undefined;

  const result: ModelPricing = {
    input: newInput,
    output: output ?? base?.output ?? 0,
    cacheRead: cacheRead ?? (rederive ? newInput * readRatio : base?.cacheRead ?? 0),
    cacheWrite5m: cacheWrite5m ?? (rederive ? newInput * CACHE_WRITE_5M_MULTIPLIER : base?.cacheWrite5m ?? 0),
    cacheWrite1h: cacheWrite1h ?? (rederive ? newInput * CACHE_WRITE_1H_MULTIPLIER : base?.cacheWrite1h ?? 0),
    contextWindow: override.contextWindow ?? base?.contextWindow ?? 200_000,
  };
  const fast = override.fastMultiplier ?? base?.fastMultiplier;
  if (fast !== undefined) result.fastMultiplier = fast;
  const intro = override.introPrice ?? (priceOverridden ? undefined : base?.introPrice);
  if (intro) result.introPrice = intro;
  return result;
}
