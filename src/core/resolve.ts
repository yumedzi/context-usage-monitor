import { ModelPricing } from './models';

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
 * Here resolution never guesses. `resolveModel` returns null on a genuine
 * miss so the UI can render an explicit "unknown model" state instead of a
 * plausible-looking wrong one.
 */
export function resolveModel(
  registry: Record<string, ModelPricing>,
  modelId: string | null | undefined,
): { key: string; entry: ModelPricing } | null {
  if (!modelId) return null;

  if (registry[modelId]) return { key: modelId, entry: registry[modelId] };

  // Longest registry key that is a *prefix* of the model id — handles
  // dated snapshot ids like "claude-haiku-4-5-20251001" resolving against
  // the bare alias "claude-haiku-4-5".
  const keys = Object.keys(registry).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (modelId.startsWith(key)) return { key, entry: registry[key] };
  }

  // Strip a trailing dated suffix (-YYYYMMDD) and retry exact match once.
  const stripped = modelId.replace(/-\d{8}$/, '');
  if (stripped !== modelId && registry[stripped]) {
    return { key: stripped, entry: registry[stripped] };
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
    return /^claude-/.test(modelId);
  }
}
