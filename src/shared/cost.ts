import type { AgentId } from './types';

export interface TokenCostInput {
  agent: AgentId;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreateTokens?: number;
  cacheReadTokens?: number;
}

export interface CostEstimate {
  currency: 'USD';
  amount: number;
}

/**
 * Deferred cost calculation seam (section 2 & 6).
 * In v1, all implementations return null and UI hides currency when showCost is false.
 */
export interface CostProvider {
  readonly id: string;
  estimateCost(input: TokenCostInput): CostEstimate | null;
}

export class NullCostProvider implements CostProvider {
  readonly id = 'null-cost-provider';

  estimateCost(_input: TokenCostInput): CostEstimate | null {
    return null;
  }
}

export const defaultCostProvider: CostProvider = new NullCostProvider();
