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

const ICON = '$(pulse) ';

export function renderStatusBar(
  state: MonitorState,
  config: ExtensionConfig,
  monthly: MonthlyUsageInfo | null,
  sessionCost: CostTotal | null,
): StatusBarRenderResult {
  const icon = config.statusBar.showIcon ? ICON : '';

  if (state.kind === 'no-activity') {
    return { text: `${icon}Claude: Ready`, backgroundColorId: null };
  }
  if (state.kind === 'idle') {
    return { text: `${icon}Claude: Idle`, backgroundColorId: null };
  }
  if (state.kind === 'off-workspace') {
    const hint = state.otherProjectHint ? ` (${state.otherProjectHint})` : '';
    return { text: `${icon}Claude: other project${hint}`, backgroundColorId: null };
  }

  const { turn } = state;
  const parts: string[] = [];
  for (const segment of config.statusBar.segments) {
    const part = renderSegment(segment, turn, config, monthly, sessionCost);
    if (part !== null) parts.push(part);
  }

  return {
    text: `${icon}${parts.join(config.statusBar.separator)}`,
    backgroundColorId: colorFor(turn, config.statusBar.colorMode),
  };
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
  monthly: MonthlyUsageInfo | null,
  sessionCost: CostTotal | null,
): string | null {
  const currency = config.pricing.currencySymbol;
  const apiEquivPrefix = config.planType === 'subscription' ? '~' : '';

  switch (segment) {
    case 'model':
      return turn.modelUnknown ? `${turn.modelLabel} (?)` : turn.modelLabel;
    case 'context':
      return turn.modelUnknown ? 'Ctx: —' : `Ctx: ${turn.contextPercent}%`;
    case 'contextTokens':
      return turn.modelUnknown
        ? null
        : `${formatTokens(turn.contextTokensUsed)}/${formatTokens(turn.contextWindow)}`;
    case 'cacheHit':
      return `Hit: ${turn.cacheHitPercent}%`;
    case 'turnCost':
      return apiEquivPrefix + formatCost(turn.turnCost, turn.turnCostKnown, currency);
    case 'sessionCost':
      return sessionCost
        ? `Session ${apiEquivPrefix}${formatCost(sessionCost.cost, sessionCost.known, currency)}`
        : null;
    case 'monthlyCost':
      return monthly
        ? `Month ${apiEquivPrefix}${formatCost(monthly.totalCostUSD, monthly.known, currency)}`
        : null;
    case 'plan':
      return config.planType === 'api' ? 'Plan: API' : 'Plan: Sub';
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
