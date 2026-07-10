import { describe, expect, it } from "vitest";

import {
  classifyRunHealth,
  type RunFailureEvidence,
  type RunHealthInput,
} from "../../src/healing/classify-failure.js";

function run(ok: number, failed: number): RunHealthInput {
  return { attempted: ok + failed, ok, failed, status: "partial" };
}

function failures(
  count: number,
  category: RunFailureEvidence["category"],
  responded: boolean,
): RunFailureEvidence[] {
  return Array.from({ length: count }, () => ({ category, responded }));
}

describe("collection run failure classification", () => {
  it("classifies a responding extraction run at 0.69 as drift", () => {
    expect(classifyRunHealth(
      run(69, 31),
      failures(31, "missing-fields", true),
    )).toBe("drift");
  });

  it("classifies HTTP 403 and repeated transport failures as blocking", () => {
    expect(classifyRunHealth(run(0, 3), failures(3, "http-403", true)))
      .toBe("blocking");
    expect(classifyRunHealth(run(0, 3), failures(3, "timeout", false)))
      .toBe("blocking");
  });

  it("errs toward blocking when responding drift and access evidence are mixed", () => {
    expect(classifyRunHealth(run(1, 3), [
      { category: "missing-fields", responded: true },
      { category: "parse", responded: true },
      { category: "captcha", responded: true },
    ])).toBe("mixed");
  });

  it("keeps a responding run at the inclusive 0.7 boundary healthy", () => {
    expect(classifyRunHealth(
      run(70, 30),
      failures(30, "missing-fields", true),
    )).toBe("healthy");
  });
});
