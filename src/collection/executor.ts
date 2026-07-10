import type { ExtractionStrategy } from "../strategies/schema.js";
import type {
  ExtractionResult,
  ProductRef,
} from "../strategies/types.js";
import { executeApi } from "./api.js";
import { executeDom } from "./dom.js";
import { executeEmbeddedJson } from "./embedded-json.js";
import type { ExtractionExecutionContext } from "./http.js";
import { executeRestrictedScript } from "./script.js";

export async function executeExtraction(
  strategy: ExtractionStrategy,
  ref: ProductRef,
  context: ExtractionExecutionContext = {},
): Promise<ExtractionResult> {
  switch (strategy.tier) {
    case "api":
      return executeApi(strategy, ref, context);
    case "embedded-json":
      return executeEmbeddedJson(strategy, ref, context);
    case "dom":
      return executeDom(strategy, ref, context);
    case "script":
      return executeRestrictedScript(strategy, ref, context);
  }
}
