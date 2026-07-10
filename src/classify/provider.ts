export interface AllowedIpcaItem {
  id: string;
  code: string;
  name: string;
}

export interface ClassificationInput {
  productId: string;
  title: string;
  brand: string | null;
  sourceCategory: string | null;
  allowedItems: readonly AllowedIpcaItem[];
}

export interface ClassificationResult {
  productId: string;
  ipcaItemId: string | null;
  confidence: number;
  rationaleCode: string;
}

export interface ClassificationAttemptEvidence {
  provider: string;
  requestedModel: string;
  actualModel: string;
  responseId: string | null;
  attempt: number;
  inputTokens: number;
  outputTokens: number;
  failureKind: string;
}

export class ClassificationProviderError extends Error {
  readonly attempts: ClassificationAttemptEvidence[];

  constructor(
    message: string,
    attempts: readonly ClassificationAttemptEvidence[],
    options: { cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ClassificationProviderError";
    this.attempts = attempts.map((attempt) => ({ ...attempt }));
  }
}

export interface ClassificationBatchResult {
  provider: string;
  model: string;
  promptVersion: string;
  promptHash: string;
  results: ClassificationResult[];
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  failedAttempts?: ClassificationAttemptEvidence[];
}

export interface ProductClassifier {
  classify(inputs: readonly ClassificationInput[]): Promise<ClassificationBatchResult>;
}
