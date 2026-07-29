import * as vscode from 'vscode';
import { formatCost, formatTokens } from './core/format';
import { RateLimitSnapshot } from './core/rateLimits';
import { ExtensionConfig, RateLimitColorThresholds, StatusBarSegment } from './settings';
import { MonitorState, MonthlyUsageInfo, TurnSnapshot } from './types';

export interface CostTotal {
  cost: number;
  known: boolean;
}

export interface StatusBarRenderResult {
  text: string;
  backgroundColorId: 'errorBackground' | 'warningBackground' | null;
}

const ICON = '$(robot) ';

export function renderStatusBar(
  state: MonitorState,
  config: ExtensionConfig,
  monthly: MonthlyUsageInfo | null,
  sessionCost: CostTotal | null,
  rates: RateLimitSnapshot | null,
): StatusBarRenderResult {
  const icon = config.statusBar.showIcon ? ICON : '';
  const sep = paddedSeparator(config.statusBar.separator);

  // Monthly-to-date and the rate-limit gauges are background stats, not tied
  // to the current turn — they render in every state (including
  // idle/no-activity) whenever enabled. A subscription's 5-hour/weekly
  // windows keep burning down whether or not this workspace has a live turn.
  const monthlyPart = renderMonthlyPart(config, monthly);
  const rateLimitParts = renderRateLimitParts(config, rates);
  const colorMode = config.statusBar.colorMode;
  const thresholds = config.rateLimits.colorThresholds;

  if (state.kind === 'no-activity') {
    return {
      text: `${icon}${assembleParts(['Claude: Ready', ...rateLimitParts], monthlyPart, sep)}`,
      backgroundColorId: colorFor(null, colorMode, rates, thresholds),
    };
  }
  if (state.kind === 'idle') {
    return {
      text: `${icon}${assembleParts(['Claude: Idle', ...rateLimitParts], monthlyPart, sep)}`,
      backgroundColorId: colorFor(null, colorMode, rates, thresholds),
    };
  }
  if (state.kind === 'off-workspace') {
    const hint = state.otherProjectHint ? ` (${state.otherProjectHint})` : '';
    return {
      text: `${icon}${assembleParts([`Claude: other project${hint}`, ...rateLimitParts], monthlyPart, sep)}`,
      backgroundColorId: colorFor(null, colorMode, rates, thresholds),
    };
  }

  const { turn } = state;
  const parts: string[] = [];
  let costInsertIndex: number | null = null;
  for (const segment of config.statusBar.segments) {
    const part = renderSegment(segment, turn, config, sessionCost);
    if (part === null) continue;
    if (costInsertIndex === null && (segment === 'turnCost' || segment === 'sessionCost')) {
      costInsertIndex = parts.length;
    }
    parts.push(part);
  }
  if (rateLimitParts.length > 0) {
    parts.splice(costInsertIndex ?? parts.length, 0, ...rateLimitParts);
  }

  return {
    text: `${icon}${assembleParts(parts, monthlyPart, sep)}`,
    backgroundColorId: colorFor(turn, colorMode, rates, thresholds),
  };
}

function assembleParts(baseParts: string[], monthlyPart: string | null, sep: string): string {
  const parts = monthlyPart ? [...baseParts, monthlyPart] : baseParts;
  return parts.join(sep);
}

function renderMonthlyPart(config: ExtensionConfig, monthly: MonthlyUsageInfo | null): string | null {
  if (!config.statusBar.showMonthlyCost || !monthly) return null;
  return `m:${formatCost(monthly.totalCostUSD, monthly.known, config.pricing.currencySymbol)}`;
}

/**
 * Renders the subscription rate-limit gauges (e.g. "5h:34%", "w:53%") as
 * separate parts so the caller can splice them individually into the
 * segment list, each getting its own separator like any other segment.
 * Returns an empty array (never a guessed number) whenever the toggle is
 * off, no snapshot is available yet, or billing isn't a subscription — the
 * feature only means anything on Pro/Max/Team, never on API-key/Bedrock/
 * Vertex/Foundry billing.
 */
function renderRateLimitParts(config: ExtensionConfig, rates: RateLimitSnapshot | null): string[] {
  if (!config.rateLimits.enabled || !rates || rates.billingMode !== 'subscription') return [];

  const parts: string[] = [];
  const staleMark = rates.stale ? '~' : '';
  if (rates.fiveHour) parts.push(`5h:${rates.fiveHour.percent}%${staleMark}`);
  if (config.rateLimits.showWeekly && rates.sevenDay) parts.push(`w:${rates.sevenDay.percent}%${staleMark}`);
  return parts;
}

/** Users configure just the separator character (e.g. "·"); spaces around it are always added here. */
function paddedSeparator(separator: string): string {
  const trimmed = separator.trim();
  return trimmed ? ` ${trimmed} ` : ' ';
}

function colorFor(
  turn: TurnSnapshot | null,
  colorMode: ExtensionConfig['statusBar']['colorMode'],
  rates: RateLimitSnapshot | null,
  rateThresholds: RateLimitColorThresholds,
): 'errorBackground' | 'warningBackground' | null {
  if (colorMode === 'rateLimit') {
    return colorForRateLimit(rates, rateThresholds);
  }
  if (!turn) return null;
  if (colorMode === 'cacheHit') {
    return turn.cacheHitPercent < 20 ? 'warningBackground' : null;
  }
  if (colorMode === 'contextFill') {
    if (turn.contextPercent >= 90) return 'errorBackground';
    if (turn.contextPercent >= 75) return 'warningBackground';
    return null;
  }
  return null;
}

function colorForRateLimit(
  rates: RateLimitSnapshot | null,
  thresholds: RateLimitColorThresholds,
): 'errorBackground' | 'warningBackground' | null {
  if (!rates || rates.billingMode !== 'subscription') return null;
  const max = Math.max(rates.fiveHour?.percent ?? 0, rates.sevenDay?.percent ?? 0);
  if (max >= thresholds.error) return 'errorBackground';
  if (max >= thresholds.warning) return 'warningBackground';
  return null;
}

function renderSegment(
  segment: StatusBarSegment,
  turn: TurnSnapshot,
  config: ExtensionConfig,
  sessionCost: CostTotal | null,
): string | null {
  const currency = config.pricing.currencySymbol;

  switch (segment) {
    case 'model': {
      if (turn.modelUnknown) return `${turn.modelLabel} (?)`;
      const effortSuffix = config.statusBar.showEffort && turn.effort ? ` (${turn.effort})` : '';
      return `${turn.modelLabel}${effortSuffix}`;
    }
    case 'context':
      return turn.modelUnknown ? 'ctx: —' : `ctx: ${turn.contextPercent}%`;
    case 'contextTokens':
      return turn.modelUnknown
        ? null
        : `${formatTokens(turn.contextTokensUsed)}/${formatTokens(turn.contextWindow)}`;
    case 'cacheHit':
      return `Hit: ${turn.cacheHitPercent}%`;
    case 'turnCost':
      return formatCost(turn.turnCost, turn.turnCostKnown, currency);
    case 'sessionCost':
      return sessionCost ? `Session ${formatCost(sessionCost.cost, sessionCost.known, currency)}` : null;
    case 'idleState':
      return null;
    default:
      return null;
  }
}

export class StatusBarController implements vscode.Disposable {
  private item: vscode.StatusBarItem;
  private alignment: 'left' | 'right' = 'right';
  private priority = 100;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, this.priority);
  }

  update(
    state: MonitorState,
    config: ExtensionConfig,
    monthly: MonthlyUsageInfo | null,
    sessionCost: CostTotal | null,
    rates: RateLimitSnapshot | null,
    tooltip: vscode.MarkdownString,
  ): void {
    if (!config.statusBar.enabled) {
      this.item.hide();
      return;
    }

    // alignment/priority are constructor-only on vscode.StatusBarItem — recreate on change.
    if (config.statusBar.alignment !== this.alignment || config.statusBar.priority !== this.priority) {
      this.alignment = config.statusBar.alignment;
      this.priority = config.statusBar.priority;
      this.item.dispose();
      this.item = vscode.window.createStatusBarItem(
        this.alignment === 'left' ? vscode.StatusBarAlignment.Left : vscode.StatusBarAlignment.Right,
        this.priority,
      );
    }

    const rendered = renderStatusBar(state, config, monthly, sessionCost, rates);
    this.item.text = rendered.text;
    this.item.tooltip = tooltip;
    this.item.command = 'contextUsageMonitor.showReport';
    this.item.backgroundColor = rendered.backgroundColorId
      ? new vscode.ThemeColor(`statusBarItem.${rendered.backgroundColorId}`)
      : undefined;
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
