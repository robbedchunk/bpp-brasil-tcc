import { readFile } from "node:fs/promises";

import { z } from "zod";

import { StrategySchema } from "../../strategies/schema.js";

const ArtifactSchema = z.object({ strategy: StrategySchema }).strict();

ArtifactSchema.parse(JSON.parse(await readFile("strategy.json", "utf8")));
process.stdout.write(
  "Artifact satisfies the exact trusted-host strategy schema. External validation is still required.\n",
);
