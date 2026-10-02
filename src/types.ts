export interface TurnSnapshot {
  model: string;
  modelLabel: string;
  /** true if the model id didn't resolve against the registry — never guess a context window, show this instead */
  modelUnknown: boolean;
  effort: string | null;
  contextPercent: number;
  contextTokensUsed: number;
  contextWindow: number;
  cacheHitPercent: number;
  inputTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  turnCost: number;
  turnCostKnown: boolean;
  timestamp: string | null;
}

export interface MonthlyUsageInfo {
  totalCostUSD: number;
  periodStartISODate: string;
  known: boolean;
  /** true when some turns could not be priced (unknown models), so totalCostUSD is a lower bound */
  partial: boolean;
  /** $ per resolved model key */
  perModel: Record<string, number>;
  /** unpriced model ids -> stats; excluded from totalCostUSD */
  unknownModels: Record<string, { records: number; tokens: number }>;
  /** clock the billing period boundary is measured on */
  timeZone: 'local' | 'utc';
}

export type MonitorState =
  | { kind: 'no-activity' }
  | { kind: 'idle' }
  | { kind: 'off-workspace'; otherProjectHint: string | null }
  | { kind: 'active'; turn: TurnSnapshot };

/** Snapshot of how the current transcript file was chosen — surfaced via the "Copy Diagnostics" command so bug reports are actionable. */
export interface WorkspaceDiagnostics {
  workspacePath: string | null;
  expectedProjectDir: string | null;
  chosenProjectDir: string | null;
  chosenFile: string | null;
  cwdVerified: boolean;
  recordCwd: string | null;
  sessionId: string | null;
}
