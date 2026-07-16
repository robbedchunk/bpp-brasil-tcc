import type { Strategy } from "../strategies/schema.js";

export type StrategyPurpose = "discovery" | "extraction";

export interface GenerationRequest {
  retailerId: string;
  purpose: StrategyPurpose;
  allowedDomains: readonly string[];
  workspacePath: string;
  prompt: string;
  /**
   * Optional per-turn timeout override in milliseconds. Healing explorations
   * pass a longer allowance than initial exploration because their retry
   * prompts carry prior-failure and replay context, and a turn aborted by the
   * timeout is charged fail-closed as unauditable spend.
   */
  timeoutMs?: number;
}

export interface GenerationUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
}

export type GenerationResult =
  | {
      status: "candidate";
      model: string;
      strategy: unknown;
      usage: GenerationUsage;
      warning?: string;
    }
  | {
      status: "provider_unavailable";
      model: string;
      usage: GenerationUsage;
      error?: string;
    }
  | {
      status: "failed";
      model: string;
      usage: GenerationUsage;
      error: string;
    }
  | {
      status: "unauditable_spend";
      model: string;
      usage: GenerationUsage;
      error: string;
    }
  | {
      status: "safety_failure";
      model: string;
      usage: GenerationUsage;
      error: string;
    };

export interface StrategyGenerator {
  generate(request: GenerationRequest): Promise<GenerationResult>;
}

export interface TrustedCandidate {
  strategy: Strategy;
}
