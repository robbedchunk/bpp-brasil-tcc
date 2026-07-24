import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { openDatabase } from "../../../../src/db/database.js";
import { buildServer } from "../../src/server/index.js";
import type { ControlRoomConfig } from "../../src/server/config.js";

const projectRoot = await mkdtemp(join(tmpdir(), "control-room-e2e-"));
const databasePath = join(projectRoot, "data/precos.sqlite");
const database = openDatabase(databasePath);
database.prepare(`
  INSERT INTO retailers
    (id, name, base_url, cep, platform_hint, domains_json, active, degraded)
  VALUES
    ('aurora-cooperative', 'Cooperativa Aurora', 'https://aurora.invalid',
     '04567-000', 'fixture', '["aurora.invalid"]', 1, 0)
`).run();
database.prepare(`
  INSERT INTO products
    (id, retailer_id, canonical_url, title, in_scope, active,
     first_seen, last_seen, descriptive_title)
  VALUES
    ('fixture-product', 'aurora-cooperative', 'https://aurora.invalid/item',
     'Produto do fixture', 1, 1, '2026-03-01', '2026-03-01', 1)
`).run();
database.close();

const packageRoot = resolve(import.meta.dirname, "../..");
const config: ControlRoomConfig = {
  packageRoot,
  projectRoot,
  databasePath,
  host: "127.0.0.1",
  port: 4328,
  actionsEnabled: false,
  development: false,
  staticRoot: resolve(packageRoot, "dist/web"),
  openaiConfigured: false,
  notificationConfigured: false,
  modelBudgetLimitUsd: null,
};
const app = await buildServer(config);
await app.listen({ host: config.host, port: config.port });

async function close() {
  await app.close();
  await rm(projectRoot, { recursive: true, force: true });
}
process.once("SIGINT", () => void close().finally(() => process.exit(130)));
process.once("SIGTERM", () => void close().finally(() => process.exit(143)));
