import { BillingMode } from './credentials';

/**
 * Parsing for Anthropic's `/api/oauth/usage` and `/api/oauth/profile`
 * responses — the same subscription rate-limit data Claude Code's own
 * status line reads, fetched directly here since transcript JSONL carries
 * none of it (the only `rateLimits` key ever written there is inside
 * `api_error` records, and it is always `null`).
 *
 * Verified against the live endpoint on 2026-07-29. `utilization` is an
 * integer percent and `resets_at` an ISO-8601 string with offset — a
 * different shape than the unix-seconds fields Claude Code's statusline
 * payload (`.rate_limits.five_hour.used_percentage`) uses; this module only
 * speaks the API shape.
 */

export interface RateWindow {
  percent: number;
  resetsAt: string | null;
}

export interface UsageWindows {
  fiveHour: RateWindow | null;
  sevenDay: RateWindow | null;
  sevenDayOpus: RateWindow | null;
  sevenDaySonnet: RateWindow | null;
}

export interface RateLimitSnapshot extends UsageWindows {
  billingMode: BillingMode;
  planLabel: string | null;
  fetchedAt: number;
  stale: boolean;
}

function readWindow(json: unknown, key: string): RateWindow | null {
  if (!json || typeof json !== 'object') return null;
  const w = (json as Record<string, unknown>)[key];
  if (!w || typeof w !== 'object') return null;
  const percent = (w as Record<string, unknown>).utilization;
  const resetsAt = (w as Record<string, unknown>).resets_at;
  if (typeof percent !== 'number') return null;
  return {
    percent,
    resetsAt: typeof resetsAt === 'string' ? resetsAt : null,
  };
}

/** Parses `/api/oauth/usage` into the four rate windows we track. A missing/null window is `null`, never `0` — never guess a plausible-looking wrong number. */
export function parseUsageResponse(json: unknown): UsageWindows {
  return {
    fiveHour: readWindow(json, 'five_hour'),
    sevenDay: readWindow(json, 'seven_day'),
    sevenDayOpus: readWindow(json, 'seven_day_opus'),
    sevenDaySonnet: readWindow(json, 'seven_day_sonnet'),
  };
}

const ORG_TYPE_TO_PLAN: Record<string, string> = {
  claude_pro: 'pro',
  claude_max: 'max',
  claude_team: 'team',
  claude_enterprise: 'enterprise',
};

/**
 * Determines billing mode and plan label. Precedence:
 * 1. An auth-override env var (API key / Bedrock / Vertex / Foundry) means
 *    API billing, regardless of anything else — checked by the caller via
 *    `detectAuthOverride` and passed in here.
 * 2. The profile endpoint's `organization.organization_type` — note
 *    `claude_enterprise` here is still *subscription* (OAuth) billing; the
 *    API-billing "enterprise" case is caught by the env-override check.
 * 3. The OAuth token's own `subscriptionType` field, if the profile call
 *    failed or omitted it.
 * 4. `account.has_claude_max` / `has_claude_pro` booleans, as a last resort.
 */
export function classifyPlan(
  profileJson: unknown,
  tokenSubscriptionType: string | null,
  authOverride: string | null,
): { billingMode: BillingMode; planLabel: string | null } {
  if (authOverride) {
    return { billingMode: 'api', planLabel: null };
  }

  const profile = profileJson && typeof profileJson === 'object' ? (profileJson as Record<string, unknown>) : null;
  const org = profile?.organization && typeof profile.organization === 'object' ? (profile.organization as Record<string, unknown>) : null;
  const orgType = typeof org?.organization_type === 'string' ? org.organization_type : null;
  if (orgType && ORG_TYPE_TO_PLAN[orgType]) {
    return { billingMode: 'subscription', planLabel: ORG_TYPE_TO_PLAN[orgType] };
  }

  if (tokenSubscriptionType) {
    return { billingMode: 'subscription', planLabel: tokenSubscriptionType };
  }

  const account = profile?.account && typeof profile.account === 'object' ? (profile.account as Record<string, unknown>) : null;
  if (account?.has_claude_max === true) return { billingMode: 'subscription', planLabel: 'max' };
  if (account?.has_claude_pro === true) return { billingMode: 'subscription', planLabel: 'pro' };

  return { billingMode: 'unknown', planLabel: null };
}

/** Formats a countdown to `resetsAtISO` from `now`: "42m", "2h 12m", "1d 4h", or "Soon" once past. */
export function formatCountdown(resetsAtISO: string, now: Date): string {
  const target = new Date(resetsAtISO).getTime();
  if (Number.isNaN(target)) return 'Soon';

  const diffMs = target - now.getTime();
  if (diffMs <= 0) return 'Soon';

  const totalMinutes = Math.floor(diffMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 24) {
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return `${days}d ${remHours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}
