import { ModelPricing } from './models';

/**
 * Default `filters.modelPattern`: Claude model ids, optionally with a
 * Bedrock/Vertex-style provider prefix (`anthropic.`, `us.anthropic.`, ...).
 * Excludes `<synthetic>` and non-Claude strings.
 */
export const DEFAULT_MODEL_PATTERN = '^(?:(?:us|eu|apac|global)\\.)?(?:anthropic\\.)?claude-';

const PROVIDER_PREFIX = /^(?:(?:us|eu|apac|global)\.)?anthropic\./;
/** Suffixes that denote a snapshot/variant of the same model, never a different one. */
const ALLOWED_SUFFIX = /^(?:-\d{8}|@\d{8}|-v\d+(?::\d+)?|\[1m\])+$/;

/** Strip a Bedrock-style provider prefix (`anthropic.`, `us.anthropic.`, `eu.`/`apac.`/`global.anthropic.`). */
export function stripProviderPrefix(modelId: string): string {
  return modelId.replace(PROVIDER_PREFIX, '');
}

/**
 * Resolve a model id against a registry.
 *
 * The upstream bug: resolveModel() only tested `modelId.startsWith(key)`.
 * When the registry's own key was longer than the model id (e.g. a scraped
 * key like "claude-sonnet-5-through-august-31,-2026" vs. the real id
 * "claude-sonnet-5"), the check silently failed and the caller fell back to
 * a hardcoded 200_000-token window and null pricing — no error, just a
 * wrong number.
 *
 * The inverse bug (also fixed here): a bare longest-prefix match priced
 * `claude-opus-5-5` as `claude-opus-5` (wrong rates, 2.5x cache reads) and
 * would do the same to any future model. A prefix match is therefore only
 * accepted when the remainder is a known snapshot/variant suffix:
 * `-YYYYMMDD`, `@YYYYMMDD`, `-v1:0`-style, or `[1m]` (combinable). Anything
 * else is a different model and must be added to the registry.
 *
 * Provider prefixes (`anthropic.`, `us.anthropic.`, ...) are stripped first.
 *
 * Resolution never guesses: `resolveModel` returns null on a genuine miss so
 * the UI can render an explicit "unknown model" state instead of a
 * plausible-looking wrong one.
 */
export function resolveModel(
  registry: Record<string, ModelPricing>,
  modelId: string | null | undefined,
): { key: string; entry: ModelPricing } | null {
  if (!modelId) return null;

  if (Object.prototype.hasOwnProperty.call(registry, modelId)) return { key: modelId, entry: registry[modelId] };

  const id = stripProviderPrefix(modelId);
  if (Object.prototype.hasOwnProperty.call(registry, id)) return { key: id, entry: registry[id] };

  // Longest registry key that is a prefix of the id *and* followed only by an
  // allowed snapshot/variant suffix.
  const keys = Object.keys(registry).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (id.length > key.length && id.startsWith(key) && ALLOWED_SUFFIX.test(id.slice(key.length))) {
      return { key, entry: registry[key] };
    }
  }

  return null;
}

/** Matches the model-filter pattern used to decide whether a record counts at all (see transcript.ts). */
export function isTrackedModel(modelId: string | null | undefined, pattern: string): boolean {
  if (!modelId) return false;
  try {
    return new RegExp(pattern).test(modelId);
  } catch {
    // Invalid user-supplied regex — fail open to the safe default rather than crash.
    return new RegExp(DEFAULT_MODEL_PATTERN).test(modelId);
  }
}
