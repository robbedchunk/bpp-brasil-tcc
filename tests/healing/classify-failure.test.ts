import { describe, expect, it } from "vitest";

import {
  assessRunHealth,
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

  it("classifies a meaningful blocking share as blocking", () => {
    expect(classifyRunHealth(run(1, 3), [
      { category: "missing-fields", responded: true },
      { category: "parse", responded: true },
      { category: "captcha", responded: true },
    ])).toBe("blocking");
  });

  it("keeps a responding run at the inclusive 0.7 boundary healthy", () => {
    expect(classifyRunHealth(
      run(70, 30),
      failures(30, "missing-fields", true),
    )).toBe("healthy");
  });

  it("treats 29/30 responding extraction failures as dominant drift despite one unknown", () => {
    const assessment = assessRunHealth(run(0, 30), [
      ...failures(29, "missing-fields", true),
      { category: "unknown", responded: false },
    ]);

    expect(assessment).toMatchObject({
      health: "drift",
      driftRatio: 29 / 30,
      blockingRatio: 0,
      ambiguousRatio: 1 / 30,
    });
  });

  it("errs toward blocking for a meaningful blocking ratio and keeps middle ratios mixed", () => {
    expect(assessRunHealth(run(0, 10), [
      ...failures(7, "missing-fields", true),
      ...failures(2, "http-403", true),
      { category: "unknown", responded: false },
    ])).toMatchObject({ health: "blocking", blockingRatio: 0.2 });

    expect(assessRunHealth(run(0, 10), [
      ...failures(6, "missing-fields", true),
      ...failures(4, "unknown", false),
    ])).toMatchObject({
      health: "mixed",
      driftRatio: 0.6,
      ambiguousRatio: 0.4,
    });
  });
});
