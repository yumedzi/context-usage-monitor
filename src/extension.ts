import * as vscode from 'vscode';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { resolveModel } from './core/resolve';
import { computeTurnCost, contextFillPercent, contextTokensUsed, cacheHitRatePercent } from './core/pricing';
import { parseUsageLine, UsageRecord } from './core/transcript';
import { encodeProjectDirName, cwdMatchesWorkspace } from './core/workspace';
import { computeMonthlyUsage, MonthlyUsageCache } from './core/usage';
import { ExtensionConfig, readConfig, buildRegistry } from './settings';
import { StatusBarController, CostTotal } from './statusBar';
import { buildTooltip } from './tooltip';
import { MonitorState, MonthlyUsageInfo, TurnSnapshot, WorkspaceDiagnostics } from './types';
import { ModelPricing } from './core/models';

const TURN_REFRESH_MS = 10_000;
const MONTHLY_REFRESH_MS = 60_000;
const IDLE_THRESHOLD_MS = 10 * 60 * 1000;
const PRICING_URL = 'https://www.claude.com/pricing#api';
const MONTHLY_CACHE_KEY = 'contextUsageMonitor.monthlyCache';

const projectsDir = path.join(os.homedir(), '.claude', 'projects');

let config: ExtensionConfig = readConfig();
let registry: Record<string, ModelPricing> = buildRegistry(config);

let statusBar: StatusBarController;
let extContext: vscode.ExtensionContext;

let currentState: MonitorState = { kind: 'no-activity' };
let currentSessionCost: CostTotal | null = null;
let currentDiagnostics: WorkspaceDiagnostics | null = null;
let currentMonthly: MonthlyUsageInfo | null = null;
let monthlyCache: MonthlyUsageCache | undefined;

export function activate(context: vscode.ExtensionContext): void {
  extContext = context;
  statusBar = new StatusBarController();
  monthlyCache = context.globalState.get<MonthlyUsageCache>(MONTHLY_CACHE_KEY);

  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('contextUsageMonitor')) return;
      config = readConfig();
      registry = buildRegistry(config);
      render();
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void refreshTurn();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('contextUsageMonitor.showReport', showReport),
    vscode.commands.registerCommand('contextUsageMonitor.recalculateMonthly', recalculateMonthly),
    vscode.commands.registerCommand('contextUsageMonitor.openPricingPage', openPricingPage),
    vscode.commands.registerCommand('contextUsageMonitor.copyDiagnostics', copyDiagnostics),
  );

  const turnTimer = setInterval(() => void refreshTurn(), TURN_REFRESH_MS);
  const monthlyTimer = setInterval(() => void refreshMonthly(), MONTHLY_REFRESH_MS);
  context.subscriptions.push({
    dispose: () => {
      clearInterval(turnTimer);
      clearInterval(monthlyTimer);
    },
  });

  void refreshTurn();
  void refreshMonthly();
}

export function deactivate(): void {
  // All timers/listeners are disposed via context.subscriptions.
}

// ---------------------------------------------------------------------------
// Turn refresh: locate the active transcript file, parse the last usable
// record, and derive the status-bar state from it.
// ---------------------------------------------------------------------------

async function refreshTurn(): Promise<void> {
  const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  const located = await locateTranscript(workspacePath);

  if (!located) {
    currentState = { kind: 'no-activity' };
    currentSessionCost = null;
    currentDiagnostics = workspacePath
      ? {
          workspacePath,
          expectedProjectDir: encodeProjectDirName(workspacePath),
          chosenProjectDir: null,
          chosenFile: null,
          cwdVerified: false,
          recordCwd: null,
          sessionId: null,
        }
      : null;
    render();
    return;
  }

  let text: string;
  try {
    text = await fsp.readFile(located.filePath, 'utf8');
  } catch {
    currentState = { kind: 'no-activity' };
    currentSessionCost = null;
    render();
    return;
  }

  const lines = text.split('\n');
  const opts = { modelPattern: config.filters.modelPattern };
  const includeSidechains = config.filters.includeSidechainsInContext;

  let mainRecord: UsageRecord | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const record = parseUsageLine(lines[i], opts);
    if (!record) continue;
    if (record.isSidechain && !includeSidechains) continue;
    mainRecord = record;
    break;
  }

  const chosenProjectDir = path.basename(path.dirname(located.filePath));
  const cwdVerified = workspacePath ? cwdMatchesWorkspace(mainRecord?.cwd ?? null, workspacePath) : true;

  currentDiagnostics = {
    workspacePath,
    expectedProjectDir: workspacePath ? encodeProjectDirName(workspacePath) : null,
    chosenProjectDir,
    chosenFile: located.filePath,
    cwdVerified,
    recordCwd: mainRecord?.cwd ?? null,
    sessionId: mainRecord?.sessionId ?? null,
  };

  currentSessionCost = computeSessionCost(lines, opts);

  if (!mainRecord) {
    currentState = { kind: 'no-activity' };
    render();
    return;
  }

  const isOffWorkspace = workspacePath !== null && (located.usedFallback || !cwdVerified);
  if (isOffWorkspace) {
    const hint = mainRecord.cwd ? path.basename(mainRecord.cwd) : chosenProjectDir;
    currentState = { kind: 'off-workspace', otherProjectHint: hint };
    render();
    return;
  }

  const ageMs = mainRecord.timestamp ? Date.now() - new Date(mainRecord.timestamp).getTime() : Infinity;
  if (ageMs > IDLE_THRESHOLD_MS) {
    currentState = { kind: 'idle' };
    render();
    return;
  }

  currentState = { kind: 'active', turn: buildTurnSnapshot(mainRecord) };
  render();
}

function buildTurnSnapshot(record: UsageRecord): TurnSnapshot {
  const resolved = resolveModel(registry, record.model);
  const entry = resolved?.entry ?? null;
  const atISODate = record.timestamp ?? new Date().toISOString();
  const { cost, known } = computeTurnCost(record.usage, entry, atISODate);

  return {
    model: record.model,
    modelLabel: stripModelPrefix(record.model),
    modelUnknown: !resolved,
    contextPercent: entry ? contextFillPercent(record.usage, entry.contextWindow) : 0,
    contextTokensUsed: contextTokensUsed(record.usage),
    contextWindow: entry?.contextWindow ?? 0,
    cacheHitPercent: cacheHitRatePercent(record.usage),
    inputTokens: record.usage.inputTokens,
    cacheWrite5mTokens: record.usage.cacheWrite5mTokens,
    cacheWrite1hTokens: record.usage.cacheWrite1hTokens,
    cacheReadTokens: record.usage.cacheReadTokens,
    outputTokens: record.usage.outputTokens,
    turnCost: cost,
    turnCostKnown: known,
    timestamp: record.timestamp,
  };
}

function stripModelPrefix(modelId: string): string {
  return modelId.replace(/^claude-/, '');
}

function computeSessionCost(lines: string[], opts: { modelPattern: string }): CostTotal {
  const seen = new Set<string>();
  let total = 0;
  for (const line of lines) {
    const record = parseUsageLine(line, opts);
    if (!record) continue;
    const key = record.messageId || record.requestId ? `${record.messageId ?? ''}::${record.requestId ?? ''}` : null;
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    const resolved = resolveModel(registry, record.model);
    if (!resolved) continue;
    const { cost, known } = computeTurnCost(record.usage, resolved.entry, record.timestamp ?? new Date().toISOString());
    if (known) total += cost;
  }
  return { cost: total, known: true };
}

interface LocatedTranscript {
  filePath: string;
  usedFallback: boolean;
}

async function locateTranscript(workspacePath: string | null): Promise<LocatedTranscript | null> {
  if (workspacePath) {
    const expectedDir = path.join(projectsDir, encodeProjectDirName(workspacePath));
    const files = await listJsonlFiles(expectedDir);
    const newest = await newestFile(files);
    if (newest) return { filePath: newest, usedFallback: false };
  }

  const allFiles = await findAllJsonlFilesRecursive(projectsDir);
  const newest = await newestFile(allFiles);
  if (newest) return { filePath: newest, usedFallback: true };

  return null;
}

async function listJsonlFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isFile() && e.name.endsWith('.jsonl')).map((e) => path.join(dir, e.name));
}

async function findAllJsonlFilesRecursive(rootDir: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        results.push(full);
      }
    }
  }
  await walk(rootDir);
  return results;
}

async function newestFile(files: string[]): Promise<string | null> {
  let best: string | null = null;
  let bestMtime = -Infinity;
  for (const file of files) {
    try {
      const stat = await fsp.stat(file);
      if (stat.mtimeMs > bestMtime) {
        bestMtime = stat.mtimeMs;
        best = file;
      }
    } catch {
      // file disappeared between listing and stat — skip
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Monthly refresh
// ---------------------------------------------------------------------------

async function refreshMonthly(): Promise<void> {
  const result = await computeMonthlyUsage(projectsDir, monthlyCache, {
    registry,
    modelPattern: config.filters.modelPattern,
    billingCycleStartDay: config.usage.billingCycleStartDay,
  });
  monthlyCache = result.cache;
  currentMonthly = {
    totalCostUSD: result.totalCostUSD,
    periodStartISODate: result.cache.billingPeriodStart,
    known: true,
  };
  await extContext.globalState.update(MONTHLY_CACHE_KEY, monthlyCache);
  render();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render(): void {
  const tooltip = buildTooltip(currentState, config, currentMonthly, currentSessionCost, currentDiagnostics);
  statusBar.update(currentState, config, currentMonthly, currentSessionCost, tooltip);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function showReport(): Promise<void> {
  const tooltip = buildTooltip(currentState, config, currentMonthly, currentSessionCost, currentDiagnostics);
  const doc = await vscode.workspace.openTextDocument({ content: tooltip.value, language: 'markdown' });
  await vscode.window.showTextDocument(doc, { preview: true });
}

async function recalculateMonthly(): Promise<void> {
  monthlyCache = undefined;
  await extContext.globalState.update(MONTHLY_CACHE_KEY, undefined);
  await refreshMonthly();
  void vscode.window.showInformationMessage('Context and Usage Monitor: monthly usage recalculated.');
}

async function openPricingPage(): Promise<void> {
  await vscode.env.openExternal(vscode.Uri.parse(PRICING_URL));
}

async function copyDiagnostics(): Promise<void> {
  const d = currentDiagnostics;
  const lines = [
    '# Context and Usage Monitor — Diagnostics',
    `workspacePath: ${d?.workspacePath ?? '(none)'}`,
    `expectedProjectDir: ${d?.expectedProjectDir ?? '(n/a)'}`,
    `chosenProjectDir: ${d?.chosenProjectDir ?? '(none)'}`,
    `chosenFile: ${d?.chosenFile ?? '(none)'}`,
    `cwdVerified: ${d?.cwdVerified ?? false}`,
    `recordCwd: ${d?.recordCwd ?? '(none)'}`,
    `sessionId: ${d?.sessionId ?? '(none)'}`,
    `state: ${currentState.kind}`,
    currentState.kind === 'active' ? `model: ${currentState.turn.model} (resolved: ${!currentState.turn.modelUnknown})` : '',
  ].filter(Boolean);
  await vscode.env.clipboard.writeText(lines.join('\n'));
  void vscode.window.showInformationMessage('Context and Usage Monitor: diagnostics copied to clipboard.');
}
