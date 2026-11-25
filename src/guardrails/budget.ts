/** Per-run token/cost budget and cost estimation. */

import type { Usage } from "../types.js";

export interface RunBudget {
  maxTokens?: number;
  maxCostUsd?: number;
}

// USD per 1M tokens: [input, output]
const PRICES: Record<string, [number, number]> = {
  "amazon.nova-lite-v1:0": [0.06, 0.24],
  "amazon.nova-pro-v1:0": [0.8, 3.2],
  "llama-3.3-70b-versatile": [0.59, 0.79],
};

export function estimateCostUsd(model: string, usage: Usage): number {
  const envIn = process.env.PRICE_INPUT_PER_MTOK;
  const envOut = process.env.PRICE_OUTPUT_PER_MTOK;
  const [tableIn, tableOut] = PRICES[model] ?? [0, 0];
  const pIn = envIn ? Number(envIn) : tableIn;
  const pOut = envOut ? Number(envOut) : tableOut;
  return (usage.inputTokens * pIn + usage.outputTokens * pOut) / 1_000_000;
}

export function budgetExceeded(budget: RunBudget, usage: Usage, costUsd: number): boolean {
  const tokens = usage.inputTokens + usage.outputTokens;
  if (budget.maxTokens !== undefined && tokens > budget.maxTokens) return true;
  if (budget.maxCostUsd !== undefined && costUsd > budget.maxCostUsd) return true;
  return false;
}
