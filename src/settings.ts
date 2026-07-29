import * as vscode from 'vscode';
import { DEFAULT_MODEL_REGISTRY, ModelPricing } from './core/models';

export type StatusBarSegment =
  | 'model'
  | 'context'
  | 'contextTokens'
  | 'cacheHit'
  | 'turnCost'
  | 'sessionCost'
  | 'monthlyCost'
  | 'plan'
  | 'idleState';

export type TooltipSection = 'turn' | 'context' | 'cache' | 'cost' | 'monthly' | 'plan' | 'links';

export interface ExtensionConfig {
  planType: 'subscription' | 'api';
  statusBar: {
    enabled: boolean;
    alignment: 'left' | 'right';
    priority: number;
    segments: StatusBarSegment[];
    separator: string;
    colorMode: 'none' | 'cacheHit' | 'contextFill';
    showIcon: boolean;
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
}

const CONFIG_SECTION = 'contextUsageMonitor';

export function readConfig(): ExtensionConfig {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return {
    planType: cfg.get('planType', 'subscription'),
    statusBar: {
      enabled: cfg.get('statusBar.enabled', true),
      alignment: cfg.get('statusBar.alignment', 'right'),
      priority: cfg.get('statusBar.priority', 100),
      segments: cfg.get('statusBar.segments', ['model', 'context', 'cacheHit', 'turnCost']),
      separator: cfg.get('statusBar.separator', ' | '),
      colorMode: cfg.get('statusBar.colorMode', 'none'),
      showIcon: cfg.get('statusBar.showIcon', true),
    },
    tooltip: {
      sections: cfg.get('tooltip.sections', ['turn', 'context', 'cache', 'cost', 'monthly', 'plan', 'links']),
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
