import * as vscode from 'vscode';
import { formatCost, formatTokens } from './core/format';
import { formatCountdown, RateLimitSnapshot } from './core/rateLimits';
import { ExtensionConfig, TooltipSection } from './settings';
import { MonitorState, MonthlyUsageInfo, TurnSnapshot, WorkspaceDiagnostics } from './types';
import { CostTotal } from './statusBar';

const PRICING_URL = 'https://www.claude.com/pricing#api';

export function buildTooltip(
  state: MonitorState,
  config: ExtensionConfig,
  monthly: MonthlyUsageInfo | null,
  sessionCost: CostTotal | null,
  rates: RateLimitSnapshot | null,
  diagnostics: WorkspaceDiagnostics | null,
): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = true;
  md.supportThemeIcons = true;

  md.appendMarkdown('**Context and Usage Monitor for Claude Code**\n\n');

  if (state.kind === 'no-activity') {
    md.appendMarkdown('No Claude Code activity found yet for this workspace.\n\n');
  } else if (state.kind === 'idle') {
    md.appendMarkdown('No recent Claude Code activity (idle).\n\n');
  } else if (state.kind === 'off-workspace') {
    md.appendMarkdown(
      `Showing activity from another project${state.otherProjectHint ? ` (\`${state.otherProjectHint}\`)` : ''}` +
        ' — no matching transcript was found for this workspace.\n\n',
    );
  }

  const turn = state.kind === 'active' ? state.turn : null;

  for (const section of config.tooltip.sections) {
    appendSection(md, section, turn, config, monthly, sessionCost, rates, diagnostics);
  }

  return md;
}

const PLAN_DISPLAY_NAMES: Record<string, string> = {
  pro: 'Claude Pro',
  max: 'Claude Max',
  team: 'Claude Team',
  enterprise: 'Claude Enterprise',
};

function planDisplayName(label: string | null): string | null {
  if (!label) return null;
  return PLAN_DISPLAY_NAMES[label] ?? `Claude (${label})`;
}

function appendRateLimitsSection(md: vscode.MarkdownString, config: ExtensionConfig, rates: RateLimitSnapshot | null): void {
  if (!config.rateLimits.enabled) return;

  if (!rates) {
    md.appendMarkdown('**Rate limits:** loading…\n\n');
    return;
  }
  if (rates.billingMode === 'api') {
    md.appendMarkdown("**Rate limits:** API key / Bedrock / Vertex / Foundry billing detected — subscription rate limits don't apply.\n\n");
    return;
  }
  if (rates.billingMode === 'unknown') {
    md.appendMarkdown('**Rate limits:** Not signed in to a Claude subscription — sign in with `claude login`.\n\n');
    return;
  }

  const now = new Date();
  if (rates.fiveHour) {
    const reset = rates.fiveHour.resetsAt ? ` — resets in ${formatCountdown(rates.fiveHour.resetsAt, now)}` : '';
    md.appendMarkdown(`**Session (5h):** ${rates.fiveHour.percent}%${reset}\n\n`);
  }
  if (config.rateLimits.showWeekly && rates.sevenDay) {
    const reset = rates.sevenDay.resetsAt ? ` — resets in ${formatCountdown(rates.sevenDay.resetsAt, now)}` : '';
    md.appendMarkdown(`**Weekly:** ${rates.sevenDay.percent}%${reset}\n\n`);
  }
  if (config.rateLimits.showPerModelWeekly) {
    if (rates.sevenDayOpus) md.appendMarkdown(`**Weekly (Opus):** ${rates.sevenDayOpus.percent}%\n\n`);
    if (rates.sevenDaySonnet) md.appendMarkdown(`**Weekly (Sonnet):** ${rates.sevenDaySonnet.percent}%\n\n`);
  }
  const planName = planDisplayName(rates.planLabel);
  if (planName) md.appendMarkdown(`**Plan:** ${planName}\n\n`);
  if (rates.stale) md.appendMarkdown('_(showing last known values — refresh failed)_\n\n');
}

function appendSection(
  md: vscode.MarkdownString,
  section: TooltipSection,
  turn: TurnSnapshot | null,
  config: ExtensionConfig,
  monthly: MonthlyUsageInfo | null,
  sessionCost: CostTotal | null,
  rates: RateLimitSnapshot | null,
  diagnostics: WorkspaceDiagnostics | null,
): void {
  const currency = config.pricing.currencySymbol;

  switch (section) {
    case 'turn':
      if (!turn) return;
      md.appendMarkdown(
        `**Model:** ${turn.modelUnknown ? `${turn.model} _(unrecognized — add it via \`contextUsageMonitor.pricing.models\`)_` : turn.modelLabel}\n\n`,
      );
      if (turn.effort) {
        md.appendMarkdown(`**Effort:** ${turn.effort}\n\n`);
      }
      return;

    case 'context':
      if (!turn) return;
      md.appendMarkdown(
        turn.modelUnknown
          ? '**Context:** unknown (model not in registry)\n\n'
          : `**Context:** ${turn.contextPercent}% (${formatTokens(turn.contextTokensUsed)} / ${formatTokens(turn.contextWindow)})\n\n`,
      );
      return;

    case 'cache':
      if (!turn) return;
      md.appendMarkdown(
        `**Cache hit rate:** ${turn.cacheHitPercent}%\n\n` +
          `- Input: ${formatTokens(turn.inputTokens)}\n` +
          `- Cache read: ${formatTokens(turn.cacheReadTokens)}\n` +
          `- Cache write (5m): ${formatTokens(turn.cacheWrite5mTokens)}\n` +
          `- Cache write (1h): ${formatTokens(turn.cacheWrite1hTokens)}\n` +
          `- Output: ${formatTokens(turn.outputTokens)}\n\n`,
      );
      return;

    case 'rateLimits':
      appendRateLimitsSection(md, config, rates);
      return;

    case 'cost':
      if (!turn) return;
      md.appendMarkdown(`**Turn cost:** ${formatCost(turn.turnCost, turn.turnCostKnown, currency)}\n\n`);
      if (sessionCost) {
        md.appendMarkdown(`**Session cost:** ${formatCost(sessionCost.cost, sessionCost.known, currency)}\n\n`);
      }
      return;

    case 'monthly':
      if (!monthly) return;
      md.appendMarkdown(
        `**Month-to-date (since ${monthly.periodStartISODate}):** ${formatCost(monthly.totalCostUSD, monthly.known, currency)}\n\n`,
      );
      return;

    case 'links':
      md.appendMarkdown(
        `[Open pricing page](${PRICING_URL}) · ` +
          `[Show usage report](command:contextUsageMonitor.showReport) · ` +
          `[Refresh rate limits](command:contextUsageMonitor.refreshRateLimits) · ` +
          `[Copy diagnostics](command:contextUsageMonitor.copyDiagnostics)\n\n`,
      );
      if (diagnostics) {
        md.appendMarkdown(
          `<sub>project dir: \`${diagnostics.chosenProjectDir ?? '—'}\` · cwd verified: ${diagnostics.cwdVerified ? 'yes' : 'no'}</sub>\n\n`,
        );
      }
      return;

    default:
      return;
  }
}
