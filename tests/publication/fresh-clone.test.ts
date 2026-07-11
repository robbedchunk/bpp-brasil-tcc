import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("fresh-clone verifier", () => {
  it("uses a disposable clone with credential-free offline commands", async () => {
    const script = await readFile(new URL("../../ops/verify-fresh-clone.sh", import.meta.url), "utf8");

    expect(script).toContain("git clone --no-local");
    expect(script).toContain("unset OPENAI_API_KEY CODEX_API_KEY NTFY_TOPIC LIVE_OPENAI");
    expect(script).toContain("DATABASE_PATH=var/acceptance/precos.sqlite");
    expect(script).toContain("npm run audit:publication -- --json");
    expect(script).toContain("npm run analysis");
    expect(script).toContain("trap cleanup EXIT");
    expect(script).toContain("PRAGMA wal_checkpoint(TRUNCATE)");
    expect(script).toContain("*.sqlite-wal");
    expect(script).toContain("*.sqlite-shm");
    expect(script).not.toContain("systemctl --user enable");
  });
});
