import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const api = spawn(
  process.execPath,
  ["--import", "tsx", "--watch", "src/server/index.ts"],
  {
    cwd: root,
    env: { ...process.env, CONTROL_ROOM_DEV: "1" },
    stdio: "inherit",
  },
);
const web = await createServer({ root });
await web.listen();
web.printUrls();

let closing = false;
async function close(exitCode = 0) {
  if (closing) return;
  closing = true;
  api.kill("SIGTERM");
  await web.close();
  process.exitCode = exitCode;
}

api.once("exit", (code, signal) => {
  if (!closing) {
    console.error(`Control Room API exited (${signal ?? code ?? "unknown"})`);
    void close(code ?? 1);
  }
});
process.once("SIGINT", () => void close(130));
process.once("SIGTERM", () => void close(143));
