import { describe, expect, it } from 'vitest';
import { parseUsageResponse, classifyPlan, formatCountdown } from '../src/core/rateLimits';

// Real /api/oauth/usage response shape, verified against the live endpoint
// on 2026-07-29 (trimmed to the fields we read).
const LIVE_PRO_USAGE = {
  five_hour: { utilization: 34, resets_at: '2026-07-29T20:50:00.376029+00:00' },
  seven_day: { utilization: 53, resets_at: '2026-07-31T00:00:00.376049+00:00' },
  seven_day_opus: null,
  seven_day_sonnet: null,
  extra_usage: { is_enabled: true, used_credits: 5311, currency: 'USD' },
};

const MAX_USAGE_WITH_PER_MODEL = {
  five_hour: { utilization: 10, resets_at: '2026-07-29T22:00:00Z' },
  seven_day: { utilization: 22, resets_at: '2026-08-01T00:00:00Z' },
  seven_day_opus: { utilization: 5, resets_at: '2026-08-01T00:00:00Z' },
  seven_day_sonnet: { utilization: 30, resets_at: '2026-08-01T00:00:00Z' },
};

const ALL_NULL_USAGE = {
  five_hour: null,
  seven_day: null,
  seven_day_opus: null,
  seven_day_sonnet: null,
};

const PRO_PROFILE = {
  account: { has_claude_max: false, has_claude_pro: true },
  organization: { organization_type: 'claude_pro', billing_type: 'stripe_subscription' },
};

describe('parseUsageResponse', () => {
  it('parses the real Pro-plan payload', () => {
    const windows = parseUsageResponse(LIVE_PRO_USAGE);
    expect(windows.fiveHour).toEqual({ percent: 34, resetsAt: '2026-07-29T20:50:00.376029+00:00' });
    expect(windows.sevenDay).toEqual({ percent: 53, resetsAt: '2026-07-31T00:00:00.376049+00:00' });
    expect(windows.sevenDayOpus).toBeNull();
    expect(windows.sevenDaySonnet).toBeNull();
  });

  it('parses per-model weekly windows on a Max-plan payload', () => {
    const windows = parseUsageResponse(MAX_USAGE_WITH_PER_MODEL);
    expect(windows.sevenDayOpus).toEqual({ percent: 5, resetsAt: '2026-08-01T00:00:00Z' });
    expect(windows.sevenDaySonnet).toEqual({ percent: 30, resetsAt: '2026-08-01T00:00:00Z' });
  });

  it('returns null (never 0) for missing/null windows', () => {
    const windows = parseUsageResponse(ALL_NULL_USAGE);
    expect(windows.fiveHour).toBeNull();
    expect(windows.sevenDay).toBeNull();
    expect(windows.sevenDayOpus).toBeNull();
    expect(windows.sevenDaySonnet).toBeNull();
  });

  it('returns all-null windows for malformed/empty input', () => {
    expect(parseUsageResponse(null)).toEqual({
      fiveHour: null,
      sevenDay: null,
      sevenDayOpus: null,
      sevenDaySonnet: null,
    });
    expect(parseUsageResponse({})).toEqual({
      fiveHour: null,
      sevenDay: null,
      sevenDayOpus: null,
      sevenDaySonnet: null,
    });
  });
});

describe('classifyPlan', () => {
  it('reports api billing when an auth override is present, regardless of profile/token', () => {
    expect(classifyPlan(PRO_PROFILE, 'pro', 'ANTHROPIC_API_KEY')).toEqual({ billingMode: 'api', planLabel: null });
  });

  it('classifies each organization_type from the profile endpoint', () => {
    expect(classifyPlan({ organization: { organization_type: 'claude_pro' } }, null, null)).toEqual({
      billingMode: 'subscription',
      planLabel: 'pro',
    });
    expect(classifyPlan({ organization: { organization_type: 'claude_max' } }, null, null)).toEqual({
      billingMode: 'subscription',
      planLabel: 'max',
    });
    expect(classifyPlan({ organization: { organization_type: 'claude_team' } }, null, null)).toEqual({
      billingMode: 'subscription',
      planLabel: 'team',
    });
    // claude_enterprise on an OAuth token is still subscription billing — the
    // API-billing "enterprise" case is caught by the auth-override check above.
    expect(classifyPlan({ organization: { organization_type: 'claude_enterprise' } }, null, null)).toEqual({
      billingMode: 'subscription',
      planLabel: 'enterprise',
    });
  });

  it('falls back to the token subscriptionType when the profile call failed/omitted it', () => {
    expect(classifyPlan(null, 'max', null)).toEqual({ billingMode: 'subscription', planLabel: 'max' });
  });

  it('falls back to has_claude_max/has_claude_pro booleans as a last resort', () => {
    expect(classifyPlan({ account: { has_claude_max: true } }, null, null)).toEqual({
      billingMode: 'subscription',
      planLabel: 'max',
    });
    expect(classifyPlan({ account: { has_claude_pro: true } }, null, null)).toEqual({
      billingMode: 'subscription',
      planLabel: 'pro',
    });
  });

  it('returns unknown when nothing indicates a plan', () => {
    expect(classifyPlan(null, null, null)).toEqual({ billingMode: 'unknown', planLabel: null });
    expect(classifyPlan({}, null, null)).toEqual({ billingMode: 'unknown', planLabel: null });
  });
});

describe('formatCountdown', () => {
  const now = new Date('2026-07-29T18:00:00Z');

  it('renders minutes only under an hour', () => {
    expect(formatCountdown('2026-07-29T18:42:00Z', now)).toBe('42m');
  });

  it('renders hours and minutes', () => {
    expect(formatCountdown('2026-07-29T20:12:00Z', now)).toBe('2h 12m');
  });

  it('renders days and hours beyond 24 hours', () => {
    expect(formatCountdown('2026-07-31T00:00:00Z', now)).toBe('1d 6h');
  });

  it('renders "Soon" once the reset time has passed', () => {
    expect(formatCountdown('2026-07-29T17:00:00Z', now)).toBe('Soon');
  });

  it('renders "Soon" for an unparsable timestamp rather than throwing', () => {
    expect(formatCountdown('not-a-date', now)).toBe('Soon');
  });
});
