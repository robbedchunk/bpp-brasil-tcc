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
}

export interface ProductClassifier {
  classify(inputs: readonly ClassificationInput[]): Promise<ClassificationBatchResult>;
}
