import * as vscode from 'vscode';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import { resolveModel } from './core/resolve';
import { computeTurnCost, contextFillPercent, contextTokensUsed, cacheHitRatePercent } from './core/pricing';
import { parseUsageLine, UsageRecord } from './core/transcript';
import { encodeProjectDirName, cwdMatchesWorkspace } from './core/workspace';
import { computeMonthlyUsage, MonthlyUsageCache } from './core/usage';
import { claudeConfigDir } from './core/credentials';
import { RateLimitSnapshot } from './core/rateLimits';
import { fetchRateLimits, readCacheMeta } from './core/usageApi';
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
const RATE_LIMIT_REFRESH_MIN_SECONDS = 30;
const RATE_LIMIT_REFRESH_MAX_SECONDS = 3600;

const projectsDir = path.join(claudeConfigDir(), 'projects');

let config: ExtensionConfig = readConfig();
let registry: Record<string, ModelPricing> = buildRegistry(config);

let statusBar: StatusBarController;
let extContext: vscode.ExtensionContext;

let currentState: MonitorState = { kind: 'no-activity' };
let currentSessionCost: CostTotal | null = null;
let currentDiagnostics: WorkspaceDiagnostics | null = null;
let currentMonthly: MonthlyUsageInfo | null = null;
let currentRates: RateLimitSnapshot | null = null;
let monthlyCache: MonthlyUsageCache | undefined;
let rateTimer: ReturnType<typeof setInterval> | undefined;

// Tracks the most recently observed transcript record's identity so a
// genuinely new Claude Code turn can trigger an immediate rate-limit
// refresh, rather than waiting on the (now much coarser) backstop timer.
let lastRateLimitTriggerKey: string | null = null;
let rateLimitBaselineSet = false;

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
      startRateTimer();
      if (config.rateLimits.enabled) {
        void refreshRateLimits();
      } else {
        currentRates = null;
        render();
      }
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
    vscode.commands.registerCommand('contextUsageMonitor.refreshRateLimits', () => refreshRateLimits(true)),
  );

  const turnTimer = setInterval(() => void refreshTurn(), TURN_REFRESH_MS);
  const monthlyTimer = setInterval(() => void refreshMonthly(), MONTHLY_REFRESH_MS);
  context.subscriptions.push({
    dispose: () => {
      clearInterval(turnTimer);
      clearInterval(monthlyTimer);
      stopRateTimer();
    },
  });

  void refreshTurn();
  void refreshMonthly();
  startRateTimer();
  void refreshRateLimits();
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

  maybeTriggerRateLimitRefresh(mainRecord);

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
    // Use the resolved registry key's clean name (e.g. "haiku-4-5"), not the
    // raw dated snapshot id (e.g. "haiku-4-5-20251001") — resolveModel()
    // already matched the id against that key for pricing purposes, so the
    // display label should reflect the same match rather than showing the
    // unresolved raw id whenever a date suffix happens to be present.
    modelLabel: stripModelPrefix(resolved?.key ?? record.model),
    modelUnknown: !resolved,
    effort: record.effort,
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
// Rate-limit refresh: 5-hour/weekly subscription gauges, fetched from
// Anthropic's OAuth usage API (see core/usageApi.ts). Only makes a network
// call when on subscription billing; silently a no-op otherwise.
//
// Two independent triggers feed the same refreshRateLimits(), which is
// always TTL-gated by core/usageApi.ts's on-disk cache — neither trigger can
// cause more than one network round-trip per refreshSeconds per machine:
//   1. maybeTriggerRateLimitRefresh(), called from refreshTurn() whenever a
//      genuinely new transcript record appears — keeps the gauge accurate
//      in near-real-time while you're actually working.
//   2. The rateTimer backstop (gated on rateLimits.scheduledCheckEnabled) —
//      exists only so the gauge doesn't go stale during a long idle stretch
//      where a rate-limit window resets with no new turn to catch it.
// ---------------------------------------------------------------------------

function clampRefreshSeconds(seconds: number): number {
  return Math.min(Math.max(seconds, RATE_LIMIT_REFRESH_MIN_SECONDS), RATE_LIMIT_REFRESH_MAX_SECONDS);
}

function startRateTimer(): void {
  stopRateTimer();
  if (!config.rateLimits.enabled || !config.rateLimits.scheduledCheckEnabled) return;
  const seconds = clampRefreshSeconds(config.rateLimits.refreshSeconds);
  rateTimer = setInterval(() => void refreshRateLimits(), seconds * 1000);
}

function stopRateTimer(): void {
  if (rateTimer) {
    clearInterval(rateTimer);
    rateTimer = undefined;
  }
}

async function refreshRateLimits(force = false): Promise<void> {
  if (!config.rateLimits.enabled) {
    currentRates = null;
    render();
    return;
  }
  currentRates = await fetchRateLimits({
    ttlMs: clampRefreshSeconds(config.rateLimits.refreshSeconds) * 1000,
    force,
  });
  render();
}

/**
 * Detects a genuinely new transcript record (by messageId/requestId, or
 * timestamp when neither is present) and triggers an immediate rate-limit
 * check — still subject to fetchRateLimits()'s own TTL, so a burst of
 * records from one agentic turn can't cause a burst of requests.
 *
 * The very first record seen after activation only establishes the
 * baseline and does *not* trigger a fetch — activate() already primes
 * currentRates once on its own, so this avoids a redundant duplicate call
 * at startup.
 */
function maybeTriggerRateLimitRefresh(record: UsageRecord): void {
  if (!config.rateLimits.enabled) return;

  const recordKey =
    record.messageId || record.requestId ? `${record.messageId ?? ''}::${record.requestId ?? ''}` : record.timestamp;
  if (!recordKey) return;

  if (!rateLimitBaselineSet) {
    lastRateLimitTriggerKey = recordKey;
    rateLimitBaselineSet = true;
    return;
  }

  if (recordKey !== lastRateLimitTriggerKey) {
    lastRateLimitTriggerKey = recordKey;
    void refreshRateLimits();
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render(): void {
  const tooltip = buildTooltip(currentState, config, currentMonthly, currentSessionCost, currentRates, currentDiagnostics);
  statusBar.update(currentState, config, currentMonthly, currentSessionCost, currentRates, tooltip);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function showReport(): Promise<void> {
  const tooltip = buildTooltip(currentState, config, currentMonthly, currentSessionCost, currentRates, currentDiagnostics);
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
  const rateMeta = await readCacheMeta();
  const rateAgeMs = currentRates ? Date.now() - currentRates.fetchedAt : null;
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
    `rateLimits.enabled: ${config.rateLimits.enabled}`,
    `rateLimits.scheduledCheckEnabled: ${config.rateLimits.scheduledCheckEnabled}`,
    `rateLimits.billingMode: ${currentRates?.billingMode ?? '(none)'}`,
    `rateLimits.planLabel: ${currentRates?.planLabel ?? '(none)'}`,
    `rateLimits.tokenSource: ${rateMeta?.tokenSource ?? '(none)'}`,
    `rateLimits.snapshotAgeMs: ${rateAgeMs ?? '(none)'}`,
    `rateLimits.stale: ${currentRates?.stale ?? false}`,
    `rateLimits.lastErrorReason: ${rateMeta?.lastErrorReason ?? '(none)'}`,
  ].filter(Boolean);
  await vscode.env.clipboard.writeText(lines.join('\n'));
  void vscode.window.showInformationMessage('Context and Usage Monitor: diagnostics copied to clipboard.');
}
