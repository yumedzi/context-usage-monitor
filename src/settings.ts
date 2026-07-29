import * as vscode from 'vscode';
import { DEFAULT_MODEL_REGISTRY, ModelPricing } from './core/models';

export type StatusBarSegment =
  | 'model'
  | 'context'
  | 'contextTokens'
  | 'cacheHit'
  | 'turnCost'
  | 'sessionCost'
  | 'idleState';

export type TooltipSection = 'turn' | 'context' | 'cache' | 'cost' | 'monthly' | 'rateLimits' | 'links';

export interface RateLimitColorThresholds {
  warning: number;
  error: number;
}

export interface ExtensionConfig {
  statusBar: {
    enabled: boolean;
    alignment: 'left' | 'right';
    priority: number;
    segments: StatusBarSegment[];
    separator: string;
    colorMode: 'none' | 'cacheHit' | 'contextFill' | 'rateLimit';
    showIcon: boolean;
    /** Show reasoning-effort level ("low"/"medium"/"high") in parentheses after the model segment. */
    showEffort: boolean;
    /** Show month-to-date usage cost, appended at the end of the status bar. Renders in every state (including idle), not just during an active turn. */
    showMonthlyCost: boolean;
  };
  tooltip: {
    sections: TooltipSection[];
  };
  pricing: {
    models: Record<string, Partial<ModelPricing>>;
    currencySymbol: string;
  };
  usage: {
    billingCycleStartDay: number;
  };
  filters: {
    modelPattern: string;
    includeSidechainsInContext: boolean;
  };
  contextWindowOverrides: Record<string, number>;
  rateLimits: {
    /** Shows 5-hour/weekly subscription rate-limit gauges in the status bar. Makes a network request to api.anthropic.com using your existing local Claude Code OAuth token — only when on a subscription plan (never on API-key/Bedrock/Vertex billing), at most once per refreshSeconds per machine. */
    enabled: boolean;
    refreshSeconds: number;
    showWeekly: boolean;
    showPerModelWeekly: boolean;
    colorThresholds: RateLimitColorThresholds;
  };
}

const CONFIG_SECTION = 'contextUsageMonitor';

export function readConfig(): ExtensionConfig {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return {
    statusBar: {
      enabled: cfg.get('statusBar.enabled', true),
      alignment: cfg.get('statusBar.alignment', 'right'),
      priority: cfg.get('statusBar.priority', 100),
      segments: cfg.get('statusBar.segments', ['model', 'context', 'turnCost']),
      separator: cfg.get('statusBar.separator', '·'),
      colorMode: cfg.get('statusBar.colorMode', 'none'),
      showIcon: cfg.get('statusBar.showIcon', true),
      showEffort: cfg.get('statusBar.showEffort', true),
      showMonthlyCost: cfg.get('statusBar.showMonthlyCost', false),
    },
    tooltip: {
      sections: cfg.get('tooltip.sections', ['turn', 'context', 'cache', 'rateLimits', 'cost', 'monthly', 'links']),
    },
    pricing: {
      models: cfg.get('pricing.models', {}),
      currencySymbol: cfg.get('pricing.currencySymbol', '$'),
    },
    usage: {
      billingCycleStartDay: cfg.get('usage.billingCycleStartDay', 1),
    },
    filters: {
      modelPattern: cfg.get('filters.modelPattern', '^claude-'),
      includeSidechainsInContext: cfg.get('filters.includeSidechainsInContext', false),
    },
    contextWindowOverrides: cfg.get('contextWindowOverrides', {}),
    rateLimits: {
      enabled: cfg.get('rateLimits.enabled', true),
      refreshSeconds: cfg.get('rateLimits.refreshSeconds', 120),
      showWeekly: cfg.get('rateLimits.showWeekly', true),
      showPerModelWeekly: cfg.get('rateLimits.showPerModelWeekly', false),
      colorThresholds: cfg.get('rateLimits.colorThresholds', { warning: 80, error: 90 }),
    },
  };
}

/**
 * Build the effective model registry: built-in defaults, deep-merged with
 * user overrides from `pricing.models` (per-field, so a user can override
 * just `contextWindow` without having to restate pricing), then the
 * `contextWindowOverrides` shortcut applied last.
 */
export function buildRegistry(config: ExtensionConfig): Record<string, ModelPricing> {
  const registry: Record<string, ModelPricing> = {};

  for (const [id, entry] of Object.entries(DEFAULT_MODEL_REGISTRY)) {
    registry[id] = { ...entry };
  }

  for (const [id, override] of Object.entries(config.pricing.models)) {
    registry[id] = { ...(registry[id] ?? blankPricing()), ...override };
  }

  for (const [id, contextWindow] of Object.entries(config.contextWindowOverrides)) {
    registry[id] = { ...(registry[id] ?? blankPricing()), contextWindow };
  }

  return registry;
}

function blankPricing(): ModelPricing {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, contextWindow: 200_000 };
}
