import * as vscode from 'vscode';
import { formatCost, formatTokens } from './core/format';
import { ExtensionConfig, TooltipSection } from './settings';
import { MonitorState, MonthlyUsageInfo, TurnSnapshot, WorkspaceDiagnostics } from './types';
import { CostTotal } from './statusBar';

const PRICING_URL = 'https://www.claude.com/pricing#api';

export function buildTooltip(
  state: MonitorState,
  config: ExtensionConfig,
  monthly: MonthlyUsageInfo | null,
  sessionCost: CostTotal | null,
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
    appendSection(md, section, turn, config, monthly, sessionCost, diagnostics);
  }

  md.appendMarkdown('\n---\n*Not affiliated with, endorsed by, or sponsored by Anthropic.*');

  return md;
}

function appendSection(
  md: vscode.MarkdownString,
  section: TooltipSection,
  turn: TurnSnapshot | null,
  config: ExtensionConfig,
  monthly: MonthlyUsageInfo | null,
  sessionCost: CostTotal | null,
  diagnostics: WorkspaceDiagnostics | null,
): void {
  const currency = config.pricing.currencySymbol;

  switch (section) {
    case 'turn':
      if (!turn) return;
      md.appendMarkdown(
        `**Model:** ${turn.modelUnknown ? `${turn.model} _(unrecognized — add it via \`contextUsageMonitor.pricing.models\`)_` : turn.modelLabel}\n\n`,
      );
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

    case 'cost': {
      if (!turn) return;
      const prefix = config.planType === 'subscription' ? '~' : '';
      const label = config.planType === 'subscription' ? 'API-equivalent' : 'Actual';
      md.appendMarkdown(`**Turn cost (${label}):** ${prefix}${formatCost(turn.turnCost, turn.turnCostKnown, currency)}\n\n`);
      if (sessionCost) {
        md.appendMarkdown(`**Session cost:** ${prefix}${formatCost(sessionCost.cost, sessionCost.known, currency)}\n\n`);
      }
      return;
    }

    case 'monthly':
      if (!monthly) return;
      md.appendMarkdown(
        `**Month-to-date (since ${monthly.periodStartISODate}):** ` +
          `${config.planType === 'subscription' ? '~' : ''}${formatCost(monthly.totalCostUSD, monthly.known, currency)}\n\n`,
      );
      return;

    case 'plan':
      md.appendMarkdown(
        `**Plan:** ${config.planType === 'api' ? 'API (pay-as-you-go)' : 'Subscription (Pro/Max/Team)'}\n\n`,
      );
      return;

    case 'links':
      md.appendMarkdown(
        `[Open pricing page](${PRICING_URL}) · ` +
          `[Show usage report](command:contextUsageMonitor.showReport) · ` +
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
