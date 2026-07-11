import type { Strategy } from "../strategies/schema.js";

export type StrategyPurpose = "discovery" | "extraction";

export interface GenerationRequest {
  retailerId: string;
  purpose: StrategyPurpose;
  allowedDomains: readonly string[];
  workspacePath: string;
  prompt: string;
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
