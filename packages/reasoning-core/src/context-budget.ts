export interface ContextWindowConfig {
  contextWindowTokens?: number;
  maxOutputTokens?: number;
}

export interface DerivedContextBudget {
  maxTokens: number;
  focusReserve: number;
  recentWindow: number;
  farHistoryTokenBudget: number;
}

const DEFAULT_MAX_TOKENS = 60000;
const DEFAULT_RECENT_WINDOW = 20;
const DEFAULT_FOCUS_RESERVE = 3000;

export function deriveContextBudget(config: ContextWindowConfig): DerivedContextBudget {
  const window = config.contextWindowTokens;
  if (!window) {
    return {
      maxTokens: DEFAULT_MAX_TOKENS,
      focusReserve: DEFAULT_FOCUS_RESERVE,
      recentWindow: DEFAULT_RECENT_WINDOW,
      farHistoryTokenBudget: Math.floor(DEFAULT_MAX_TOKENS * 0.45),
    };
  }

  const outputReserve = config.maxOutputTokens ?? Math.max(2048, Math.floor(window * 0.08));
  const safetyReserve = Math.max(4000, Math.min(12000, Math.floor(window * 0.1)));
  const maxTokens = Math.max(8000, window - outputReserve - safetyReserve);
  const recentWindow = window >= 100000 ? 40 : window >= 64000 ? 30 : DEFAULT_RECENT_WINDOW;

  return {
    maxTokens,
    focusReserve: DEFAULT_FOCUS_RESERVE,
    recentWindow,
    farHistoryTokenBudget: Math.floor(maxTokens * 0.75),
  };
}

export function shouldCompressFarHistory({
  farHistoryTokens,
  budget,
}: {
  farHistoryTokens: number;
  budget: DerivedContextBudget;
}): boolean {
  return farHistoryTokens > budget.farHistoryTokenBudget;
}
