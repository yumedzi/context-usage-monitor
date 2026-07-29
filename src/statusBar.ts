import * as vscode from 'vscode';
import { formatCost, formatTokens } from './core/format';
import { ExtensionConfig, StatusBarSegment } from './settings';
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
): StatusBarRenderResult {
  const icon = config.statusBar.showIcon ? ICON : '';
  const sep = paddedSeparator(config.statusBar.separator);

  // Monthly-to-date is a background stat, not tied to the current turn — it
  // renders in every state (including idle/no-activity) whenever enabled.
  const monthlyPart = renderMonthlyPart(config, monthly);

  if (state.kind === 'no-activity') {
    return { text: `${icon}${assembleParts(['Claude: Ready'], monthlyPart, sep)}`, backgroundColorId: null };
  }
  if (state.kind === 'idle') {
    return { text: `${icon}${assembleParts(['Claude: Idle'], monthlyPart, sep)}`, backgroundColorId: null };
  }
  if (state.kind === 'off-workspace') {
    const hint = state.otherProjectHint ? ` (${state.otherProjectHint})` : '';
    return {
      text: `${icon}${assembleParts([`Claude: other project${hint}`], monthlyPart, sep)}`,
      backgroundColorId: null,
    };
  }

  const { turn } = state;
  const parts: string[] = [];
  for (const segment of config.statusBar.segments) {
    const part = renderSegment(segment, turn, config, sessionCost);
    if (part !== null) parts.push(part);
  }

  return {
    text: `${icon}${assembleParts(parts, monthlyPart, sep)}`,
    backgroundColorId: colorFor(turn, config.statusBar.colorMode),
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

/** Users configure just the separator character (e.g. "·"); spaces around it are always added here. */
function paddedSeparator(separator: string): string {
  const trimmed = separator.trim();
  return trimmed ? ` ${trimmed} ` : ' ';
}

function colorFor(
  turn: TurnSnapshot,
  colorMode: ExtensionConfig['statusBar']['colorMode'],
): 'errorBackground' | 'warningBackground' | null {
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

    const rendered = renderStatusBar(state, config, monthly, sessionCost);
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
