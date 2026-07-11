import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export const PLAN_PATH = "data/validation/successor-plans.json";
export const RECOVERY_PLAN_PATH = "data/validation/successor-recovery-plan.json";
export const PUBLIC_KEY_PATH = "ops/validation-attestation-public.pem";
export const VALIDATOR_DIGEST_PATH = "ops/validator-bundle.sha256";
export const OVERLAY_PATH = "var/validation-rollout-configs";
export const RECOVERY_OVERLAY_PREFIX = "var/validation-recovery-";
export const SUCCESSOR_TOOL_PATHS = [
  "scripts/apply-validation-successors.mjs",
  "scripts/prepare-validation-successors.mjs",
  "scripts/successor-tooling.mjs",
];
export const TRUSTED_IMPLEMENTATION_PATHS = [
  "scripts",
  "src",
  "retailers",
  "ops/validator-bundle.sha256",
  "ops/validation-attestation-public.pem",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
];
export const PURPOSES = ["discovery", "extraction"];

const SHA256 = /^[a-f0-9]{64}$/u;
const RETAILER_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const PLAN_KEYS = [
  "fromVersion",
  "purpose",
  "reason",
  "retailerId",
  "strategySha256",
  "toVersion",
].sort();
const RECOVERY_PARENT_KEYS = [
  "attestationKeyId",
  "planFileSha256",
  "planPath",
  "sourceCommit",
  "validatorArtifactSha256",
].sort();
const RECOVERY_PLAN_KEYS = [
  "activeStrategySha256",
  "activeVersion",
  "candidateFileSha256",
  "candidatePath",
  "failedAttemptFileSha256",
  "failedAttemptPath",
  "failedAttemptReceiptSha256",
  "failedAttemptSampleSetSha256",
  "failedStrategySha256",
  "failedVersion",
  "purpose",
  "reason",
  "retailerId",
  "strategySha256",
  "toVersion",
].sort();

function parseRecoveryConfigPatch(input, index) {
  if (input === undefined) return undefined;
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`Recovery plan entry ${index + 1} configPatch must be an object`);
  }
  const keys = Object.keys(input).sort();
  if (keys.some((key) => !["cep", "platformEvidence", "storeMapping"].includes(key))) {
    throw new Error(`Recovery plan entry ${index + 1} configPatch has forbidden fields`);
  }
  if (input.cep !== undefined && (typeof input.cep !== "string" || !/^\d{5}-\d{3}$/u.test(input.cep))) {
    throw new Error(`Recovery plan entry ${index + 1} configPatch CEP is malformed`);
  }
  if (input.platformEvidence !== undefined && (
    !exactKeys(input.platformEvidence, ["notes", "observedAt", "platform", "urls"])
    || typeof input.platformEvidence.platform !== "string"
    || typeof input.platformEvidence.observedAt !== "string"
    || !Array.isArray(input.platformEvidence.urls)
    || typeof input.platformEvidence.notes !== "string"
  )) {
    throw new Error(`Recovery plan entry ${index + 1} platformEvidence patch is malformed`);
  }
  if (input.storeMapping !== undefined && input.storeMapping !== null && (
    !exactKeys(input.storeMapping, ["erpCode", "evidenceUrl", "storeId"])
    || typeof input.storeMapping.storeId !== "string"
    || !(input.storeMapping.erpCode === null || typeof input.storeMapping.erpCode === "string")
    || typeof input.storeMapping.evidenceUrl !== "string"
  )) {
    throw new Error(`Recovery plan entry ${index + 1} storeMapping patch is malformed`);
  }
  return structuredClone(input);
}

export function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, child]) => [key, canonicalValue(child)]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function valueSha256(value) {
  return sha256(canonicalJson(value));
}

export function readJsonFile(path, label) {
  const status = lstatSync(path);
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new Error(`${label} must be a regular, non-symbolic-link file`);
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
}

function exactKeys(value, expected) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === expected.join("\0");
}

export function parseSuccessorPlan(input) {
  if (!exactKeys(input, ["plans", "schemaVersion"])) {
    throw new Error("Successor plan must contain exactly schemaVersion and plans");
  }
  if (input.schemaVersion !== 1 || !Array.isArray(input.plans) || input.plans.length !== 8) {
    throw new Error("Successor plan must be schema 1 with exactly eight entries");
  }
  const plans = input.plans.map((candidate, index) => {
    if (!exactKeys(candidate, PLAN_KEYS)) {
      throw new Error(`Successor plan entry ${index + 1} has unexpected fields`);
    }
    if (
      typeof candidate.retailerId !== "string"
      || !RETAILER_ID.test(candidate.retailerId)
      || !PURPOSES.includes(candidate.purpose)
      || !Number.isSafeInteger(candidate.fromVersion)
      || candidate.fromVersion <= 0
      || !Number.isSafeInteger(candidate.toVersion)
      || candidate.toVersion !== candidate.fromVersion + 1
      || typeof candidate.strategySha256 !== "string"
      || !SHA256.test(candidate.strategySha256)
      || candidate.strategySha256 === "0".repeat(64)
      || typeof candidate.reason !== "string"
      || candidate.reason.trim() !== candidate.reason
      || candidate.reason.length === 0
    ) {
      throw new Error(`Successor plan entry ${index + 1} is malformed`);
    }
    return { ...candidate };
  });
  const identities = plans.map(({ retailerId, purpose }) => `${retailerId}/${purpose}`);
  if (new Set(identities).size !== identities.length) {
    throw new Error("Successor plan contains duplicate retailer/purpose entries");
  }
  const retailers = [...new Set(plans.map(({ retailerId }) => retailerId))].sort();
  if (retailers.length !== 4) {
    throw new Error("Successor plan must cover exactly four retailers");
  }
  for (const retailerId of retailers) {
    const purposes = plans
      .filter((entry) => entry.retailerId === retailerId)
      .map(({ purpose }) => purpose)
      .sort();
    if (purposes.join("\0") !== [...PURPOSES].sort().join("\0")) {
      throw new Error(`Successor plan must cover both purposes for ${retailerId}`);
    }
  }
  return plans.sort((left, right) => {
    const retailer = left.retailerId.localeCompare(right.retailerId, "en");
    return retailer === 0 ? left.purpose.localeCompare(right.purpose, "en") : retailer;
  });
}

export function parseRecoveryPlan(input) {
  if (!exactKeys(input, ["parent", "plans", "schemaVersion"])
    || input.schemaVersion !== 1
    || !exactKeys(input.parent, RECOVERY_PARENT_KEYS)
    || !Array.isArray(input.plans)
    || input.plans.length !== 2) {
    throw new Error("Recovery plan must be schema 1 with an exact parent and two entries");
  }
  const parent = input.parent;
  if (typeof parent.sourceCommit !== "string" || !/^[a-f0-9]{40}$/u.test(parent.sourceCommit)
    || parent.planPath !== PLAN_PATH
    || typeof parent.planFileSha256 !== "string" || !SHA256.test(parent.planFileSha256)
    || typeof parent.validatorArtifactSha256 !== "string" || !SHA256.test(parent.validatorArtifactSha256)
    || typeof parent.attestationKeyId !== "string" || !SHA256.test(parent.attestationKeyId)) {
    throw new Error("Recovery plan parent binding is malformed");
  }
  const plans = input.plans.map((candidate, index) => {
    const expectedKeys = candidate?.configPatch === undefined
      ? RECOVERY_PLAN_KEYS
      : [...RECOVERY_PLAN_KEYS, "configPatch"].sort();
    if (!exactKeys(candidate, expectedKeys)
      || typeof candidate.retailerId !== "string" || !RETAILER_ID.test(candidate.retailerId)
      || !PURPOSES.includes(candidate.purpose)
      || !Number.isSafeInteger(candidate.activeVersion) || candidate.activeVersion <= 0
      || candidate.failedVersion !== candidate.activeVersion + 1
      || candidate.toVersion !== candidate.failedVersion + 1
      || typeof candidate.activeStrategySha256 !== "string" || !SHA256.test(candidate.activeStrategySha256)
      || typeof candidate.failedStrategySha256 !== "string" || !SHA256.test(candidate.failedStrategySha256)
      || typeof candidate.strategySha256 !== "string" || !SHA256.test(candidate.strategySha256)
      || candidate.strategySha256 === candidate.activeStrategySha256
      || candidate.strategySha256 === candidate.failedStrategySha256
      || typeof candidate.candidatePath !== "string"
      || candidate.candidatePath !== `data/validation/candidates/${candidate.retailerId}-${candidate.purpose}-v${candidate.toVersion}.json`
      || typeof candidate.candidateFileSha256 !== "string" || !SHA256.test(candidate.candidateFileSha256)
      || candidate.failedAttemptPath !== `data/validation/attempts/${candidate.retailerId}-${candidate.purpose}-v${candidate.failedVersion}.json`
      || typeof candidate.failedAttemptFileSha256 !== "string" || !SHA256.test(candidate.failedAttemptFileSha256)
      || typeof candidate.failedAttemptReceiptSha256 !== "string" || !SHA256.test(candidate.failedAttemptReceiptSha256)
      || typeof candidate.failedAttemptSampleSetSha256 !== "string" || !SHA256.test(candidate.failedAttemptSampleSetSha256)
      || typeof candidate.reason !== "string" || candidate.reason.trim() !== candidate.reason
      || candidate.reason.length === 0) {
      throw new Error(`Recovery plan entry ${index + 1} is malformed`);
    }
    return {
      ...candidate,
      ...(candidate.configPatch === undefined
        ? {}
        : { configPatch: parseRecoveryConfigPatch(candidate.configPatch, index) }),
    };
  }).sort((left, right) => {
    const retailer = left.retailerId.localeCompare(right.retailerId, "en");
    return retailer === 0 ? left.purpose.localeCompare(right.purpose, "en") : retailer;
  });
  const identities = plans.map(({ retailerId, purpose }) => `${retailerId}/${purpose}`);
  if (canonicalJson(identities) !== canonicalJson([
    "carrefour/extraction",
    "extra-mercado/discovery",
  ])) {
    throw new Error("Recovery plan must cover exactly Carrefour extraction and Extra discovery");
  }
  return { schemaVersion: 1, parent: { ...parent }, plans };
}

export function recoveryOverlayPath(root, recovery) {
  return resolve(root, `${RECOVERY_OVERLAY_PREFIX}${sha256(canonicalJson(recovery))}`);
}

export function applyRecoveryConfigPatch(config, plan) {
  const desired = structuredClone(config);
  for (const [key, value] of Object.entries(plan.configPatch ?? {})) {
    desired[key] = structuredClone(value);
  }
  return desired;
}

export function git(root, arguments_) {
  return execFileSync("git", arguments_, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function assertProjectRoot(root) {
  const absolute = resolve(root);
  const top = resolve(git(absolute, ["rev-parse", "--show-toplevel"]));
  if (top !== absolute) throw new Error("Project root must be the Git worktree root");
  return absolute;
}

export function assertTrackedUnmodified(root, paths) {
  const unique = [...new Set(paths)].sort();
  for (const path of unique) {
    git(root, ["ls-files", "--error-unmatch", "--", path]);
  }
  const changed = execFileSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=no", "--", ...unique],
    { cwd: root, encoding: "utf8" },
  ).trim();
  if (changed !== "") {
    throw new Error(`Successor tooling requires committed tracked inputs; changed:\n${changed}`);
  }
}

export function assertTrustedImplementationClean(root) {
  const changed = execFileSync(
    "git",
    [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--",
      ...TRUSTED_IMPLEMENTATION_PATHS,
    ],
    { cwd: root, encoding: "utf8" },
  ).trim();
  if (changed !== "") {
    throw new Error(
      `Successor tooling requires a clean trusted implementation surface; changed:\n${changed}`,
    );
  }
}

function assertObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

export function inspectPlannedConfigs(root, plans, options = {}) {
  const byRetailer = new Map();
  for (const plan of plans) {
    const entries = byRetailer.get(plan.retailerId) ?? [];
    entries.push(plan);
    byRetailer.set(plan.retailerId, entries);
  }
  const configPaths = [...byRetailer.keys()].sort().map((id) => `retailers/${id}.json`);
  if (options.requireTracked !== false) {
    assertTrackedUnmodified(root, [PLAN_PATH, ...configPaths]);
  }
  const configs = [];
  for (const [retailerId, entries] of [...byRetailer.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "en"))) {
    const relativePath = `retailers/${retailerId}.json`;
    const config = assertObject(readJsonFile(resolve(root, relativePath), relativePath), relativePath);
    if (config.schemaVersion !== 1 || config.id !== retailerId || config.active !== true) {
      throw new Error(`${relativePath} must be the active schema-1 config for ${retailerId}`);
    }
    const versions = assertObject(config.strategyVersions, `${relativePath} strategyVersions`);
    const validation = assertObject(config.validation, `${relativePath} validation`);
    for (const plan of entries) {
      const strategy = assertObject(config[plan.purpose], `${relativePath} ${plan.purpose}`);
      const metadata = assertObject(validation[plan.purpose], `${relativePath} validation.${plan.purpose}`);
      if (strategy.purpose !== plan.purpose) {
        throw new Error(`${relativePath} contains a mismatched ${plan.purpose} strategy`);
      }
      const version = versions[plan.purpose];
      const allowedVersions = options.allowApplied === true
        ? [plan.fromVersion, plan.toVersion]
        : [plan.fromVersion];
      if (!allowedVersions.includes(version)) {
        throw new Error(
          `${relativePath} ${plan.purpose} must be version ${allowedVersions.join(" or ")}`,
        );
      }
      if (valueSha256(strategy) !== plan.strategySha256) {
        throw new Error(`${relativePath} ${plan.purpose} strategy hash differs from its plan`);
      }
      const currentReceipt = `data/validation/${retailerId}-${plan.purpose}-v${version}.json`;
      if (metadata.receiptPath !== currentReceipt) {
        throw new Error(`${relativePath} is not bound to current receipt ${currentReceipt}`);
      }
    }
    configs.push({ retailerId, path: relativePath, config, plans: entries });
  }
  return configs;
}

export function inspectRecoveryConfigs(root, recovery, options = {}) {
  const paths = [
    RECOVERY_PLAN_PATH,
    ...recovery.plans.map(({ candidatePath }) => candidatePath),
    ...recovery.plans.map(({ retailerId }) => `retailers/${retailerId}.json`),
  ];
  if (options.requireTracked !== false) assertTrackedUnmodified(root, paths);
  return recovery.plans.map((plan) => {
    const path = `retailers/${plan.retailerId}.json`;
    const config = assertObject(readJsonFile(resolve(root, path), path), path);
    const candidatePath = resolve(root, plan.candidatePath);
    const candidateRaw = readFileSync(candidatePath);
    const candidateStrategy = assertObject(
      readJsonFile(candidatePath, plan.candidatePath),
      plan.candidatePath,
    );
    if (config.schemaVersion !== 1 || config.id !== plan.retailerId || config.active !== true
      || candidateStrategy.purpose !== plan.purpose
      || sha256(candidateRaw) !== plan.candidateFileSha256
      || valueSha256(candidateStrategy) !== plan.strategySha256) {
      throw new Error(`${plan.retailerId}/${plan.purpose} recovery candidate is misbound`);
    }
    const version = config.strategyVersions?.[plan.purpose];
    const state = version === plan.activeVersion ? "pending"
      : options.allowApplied === true && version === plan.toVersion ? "applied"
        : null;
    if (state === null) {
      throw new Error(
        `${path} ${plan.purpose} must be active version ${plan.activeVersion}`
        + (options.allowApplied === true ? ` or recovered version ${plan.toVersion}` : ""),
      );
    }
    const expectedStrategy = state === "pending"
      ? plan.activeStrategySha256
      : plan.strategySha256;
    const expectedReceipt = `data/validation/${plan.retailerId}-${plan.purpose}-v${version}.json`;
    if (valueSha256(config[plan.purpose]) !== expectedStrategy
      || config.validation?.[plan.purpose]?.receiptPath !== expectedReceipt) {
      throw new Error(`${plan.retailerId}/${plan.purpose} config recovery state is not exact`);
    }
    return {
      retailerId: plan.retailerId,
      path,
      config,
      plans: [{ ...plan, candidateStrategy }],
      state,
    };
  });
}

export function verifyRecoveryFailedAttemptFiles(root, recovery, options = {}) {
  const manifestPath = "data/validation/attempts/manifest.json";
  const tracked = [manifestPath, ...recovery.plans.map(({ failedAttemptPath }) => failedAttemptPath)];
  if (options.requireTracked !== false) assertTrackedUnmodified(root, tracked);
  const manifest = readJsonFile(resolve(root, manifestPath), "failed-attempt manifest");
  if (!exactKeys(manifest, ["attempts", "schemaVersion"])
    || manifest.schemaVersion !== 1 || !Array.isArray(manifest.attempts)) {
    throw new Error("Failed-attempt manifest is malformed");
  }
  for (const plan of recovery.plans) {
    const absoluteAttempt = resolve(root, plan.failedAttemptPath);
    const receipt = readJsonFile(absoluteAttempt, plan.failedAttemptPath);
    const raw = readFileSync(absoluteAttempt);
    const entries = manifest.attempts.filter((entry) => entry?.path === plan.failedAttemptPath);
    if (entries.length !== 1
      || !exactKeys(entries[0], [
        "fileSha256",
        "path",
        "receiptSha256",
        "strategySourceCommit",
      ])
      || entries[0].fileSha256 !== plan.failedAttemptFileSha256
      || entries[0].receiptSha256 !== plan.failedAttemptReceiptSha256
      || entries[0].strategySourceCommit !== recovery.parent.sourceCommit
      || sha256(raw) !== plan.failedAttemptFileSha256
      || receipt.retailerId !== plan.retailerId
      || receipt.purpose !== plan.purpose
      || receipt.strategyVersion !== plan.failedVersion
      || receipt.strategySha256 !== plan.failedStrategySha256
      || receipt.sampleSetSha256 !== plan.failedAttemptSampleSetSha256
      || receipt.executor?.sourceCommit !== recovery.parent.sourceCommit
      || receipt.executor?.artifactSha256 !== recovery.parent.validatorArtifactSha256
      || receipt.executor?.challengeAlgorithm
        !== "active-in-scope-category-url-bucket-round-robin-v1"
      || receipt.attempted !== 30 || receipt.valid >= 27 || receipt.activatable !== false) {
      throw new Error(`${plan.retailerId}/${plan.purpose} burned attempt is misbound`);
    }
  }
  return true;
}

export function preparedConfig(entry) {
  let desired = structuredClone(entry.config);
  for (const plan of entry.plans) {
    desired = applyRecoveryConfigPatch(desired, plan);
    if (plan.candidateStrategy !== undefined) {
      desired[plan.purpose] = structuredClone(plan.candidateStrategy);
    }
    desired.strategyVersions[plan.purpose] = plan.toVersion;
    desired.validation[plan.purpose].receiptPath =
      `data/validation/${plan.retailerId}-${plan.purpose}-v${plan.toVersion}.json`;
  }
  return desired;
}

export function formattedJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function assertContained(parent, child, label) {
  const relativePath = relative(resolve(parent), resolve(child));
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`)
  ) {
    throw new Error(`${label} must be a strict descendant of ${parent}`);
  }
}

function fsyncDirectory(path) {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeExclusive(path, content, mode) {
  const descriptor = openSync(path, "wx", mode);
  try {
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function expectedOverlayFiles(configs) {
  return configs.map((entry) => ({
    name: `${entry.retailerId}.json`,
    content: formattedJson(preparedConfig(entry)),
  }));
}

function validateExistingOverlay(path, files) {
  const status = lstatSync(path);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error("Existing validation overlay is not a private regular directory");
  }
  const names = readdirSync(path).sort();
  if (names.join("\0") !== files.map(({ name }) => name).sort().join("\0")) {
    throw new Error("Existing validation overlay has unexpected or missing files");
  }
  for (const file of files) {
    const target = join(path, file.name);
    const fileStatus = lstatSync(target);
    if (!fileStatus.isFile() || fileStatus.isSymbolicLink()
      || readFileSync(target, "utf8") !== file.content) {
      throw new Error(`Existing validation overlay differs at ${file.name}`);
    }
    chmodSync(target, 0o600);
  }
  chmodSync(path, 0o700);
}

export function writePrivateOverlay(root, configs, overlay = resolve(root, OVERLAY_PATH)) {
  const varDirectory = resolve(root, "var");
  const absoluteOverlay = resolve(overlay);
  assertContained(varDirectory, absoluteOverlay, "Validation overlay");
  mkdirSync(varDirectory, { recursive: true, mode: 0o700 });
  const varStatus = lstatSync(varDirectory);
  if (!varStatus.isDirectory() || varStatus.isSymbolicLink()) {
    throw new Error("Project var path must be a regular directory");
  }
  if (realpathSync(varDirectory) !== varDirectory) {
    throw new Error("Project var path cannot traverse symbolic links");
  }
  chmodSync(varDirectory, 0o700);
  const files = expectedOverlayFiles(configs);
  if (existsSync(absoluteOverlay)) {
    validateExistingOverlay(absoluteOverlay, files);
    return absoluteOverlay;
  }
  const temporary = join(
    dirname(absoluteOverlay),
    `.${basename(absoluteOverlay)}.${process.pid}.${randomUUID()}.tmp`,
  );
  mkdirSync(temporary, { mode: 0o700 });
  try {
    for (const file of files) writeExclusive(join(temporary, file.name), file.content, 0o600);
    fsyncDirectory(temporary);
    renameSync(temporary, absoluteOverlay);
    fsyncDirectory(dirname(absoluteOverlay));
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
  validateExistingOverlay(absoluteOverlay, files);
  return absoluteOverlay;
}

export function verifyOverlay(root, configs, overlay = resolve(root, OVERLAY_PATH)) {
  const files = expectedOverlayFiles(configs);
  validateExistingOverlay(resolve(overlay), files);
  return files;
}

export function verifyCommittedPlan(root, plans, configEntries, sourceCommit) {
  const head = git(root, ["rev-parse", "--verify", "HEAD"]);
  const commit = sourceCommit ?? head;
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error("HEAD is not a full Git commit");
  if (!/^[a-f0-9]{40}$/u.test(head)
    || (() => {
      try {
        git(root, ["merge-base", "--is-ancestor", commit, head]);
        return false;
      } catch {
        return true;
      }
    })()) {
    throw new Error("Validation source commit must be an ancestor of current HEAD");
  }
  const committedPlan = parseSuccessorPlan(JSON.parse(git(root, ["show", `${commit}:${PLAN_PATH}`])));
  if (canonicalJson(committedPlan) !== canonicalJson(plans)) {
    throw new Error("Working successor plan does not exactly match its source commit");
  }
  for (const entry of configEntries) {
    const committed = JSON.parse(git(root, ["show", `${commit}:${entry.path}`]));
    if (canonicalJson(committed) !== canonicalJson(entry.config)) {
      throw new Error(`${entry.path} does not exactly match source commit ${commit}`);
    }
  }
  return commit;
}

export function verifyCommittedRecoveryPlan(root, recovery, configEntries, sourceCommit) {
  const head = git(root, ["rev-parse", "--verify", "HEAD"]);
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit) || !/^[a-f0-9]{40}$/u.test(head)) {
    throw new Error("Recovery source must be a full Git commit");
  }
  git(root, ["merge-base", "--is-ancestor", recovery.parent.sourceCommit, sourceCommit]);
  git(root, ["merge-base", "--is-ancestor", sourceCommit, head]);
  const committed = parseRecoveryPlan(JSON.parse(
    git(root, ["show", `${sourceCommit}:${RECOVERY_PLAN_PATH}`]),
  ));
  if (canonicalJson(committed) !== canonicalJson(recovery)) {
    throw new Error("Working recovery plan differs from its source commit");
  }
  const parentPlan = execFileSync(
    "git",
    ["show", `${recovery.parent.sourceCommit}:${recovery.parent.planPath}`],
    { cwd: root },
  );
  if (sha256(parentPlan) !== recovery.parent.planFileSha256) {
    throw new Error("Recovery parent plan digest is invalid");
  }
  const parentEntries = parseSuccessorPlan(JSON.parse(parentPlan.toString("utf8")));
  const parentValidator = git(root, [
    "show",
    `${recovery.parent.sourceCommit}:${VALIDATOR_DIGEST_PATH}`,
  ]).trim();
  if (parentValidator !== recovery.parent.validatorArtifactSha256) {
    throw new Error("Recovery parent validator digest is invalid");
  }
  for (const entry of configEntries) {
    const historical = JSON.parse(git(root, ["show", `${sourceCommit}:${entry.path}`]));
    if (canonicalJson(historical) !== canonicalJson(entry.config)) {
      throw new Error(`${entry.path} differs from recovery source ${sourceCommit}`);
    }
    for (const plan of entry.plans) {
      const parentEntry = parentEntries.find((candidate) =>
        candidate.retailerId === plan.retailerId && candidate.purpose === plan.purpose);
      if (entry.config.strategyVersions?.[plan.purpose] !== plan.activeVersion
        || valueSha256(entry.config[plan.purpose]) !== plan.activeStrategySha256
        || parentEntry === undefined
        || parentEntry.fromVersion !== plan.activeVersion
        || parentEntry.toVersion !== plan.failedVersion
        || parentEntry.strategySha256 !== plan.failedStrategySha256) {
        throw new Error(`${plan.retailerId}/${plan.purpose} recovery lineage is invalid`);
      }
      const candidate = execFileSync(
        "git",
        ["show", `${sourceCommit}:${plan.candidatePath}`],
        { cwd: root },
      );
      if (sha256(candidate) !== plan.candidateFileSha256
        || canonicalJson(JSON.parse(candidate.toString("utf8")))
          !== canonicalJson(plan.candidateStrategy)) {
        throw new Error(`${plan.candidatePath} differs from recovery source ${sourceCommit}`);
      }
    }
  }
  return sourceCommit;
}

function walkRegularFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = join(directory, name);
      const path = relative(root, absolute).split(sep).join("/");
      const status = lstatSync(absolute);
      if (status.isDirectory() && !status.isSymbolicLink()) visit(absolute);
      else if (status.isFile() && !status.isSymbolicLink()) {
        if (path !== "build-manifest.json") {
          files.push({ path, sha256: sha256(readFileSync(absolute)), bytes: status.size });
        }
      } else if (status.isSymbolicLink()) {
        throw new Error(`dist contains forbidden symbolic link ${path}`);
      } else throw new Error(`dist contains unsupported filesystem entry ${path}`);
    }
  };
  visit(root);
  return files;
}

export function verifyCleanBuild(root, sourceCommit) {
  const dist = resolve(root, "dist");
  const manifest = readJsonFile(join(dist, "build-manifest.json"), "dist build manifest");
  if (
    manifest.schemaVersion !== 1
    || manifest.sourceCommit !== sourceCommit
    || manifest.sourceClean !== true
    || !Array.isArray(manifest.files)
    || typeof manifest.artifactSetSha256 !== "string"
    || !SHA256.test(manifest.artifactSetSha256)
  ) {
    throw new Error("dist build manifest is absent, dirty, or bound to another source commit");
  }
  const actual = walkRegularFiles(dist);
  if (canonicalJson(actual) !== canonicalJson(manifest.files)) {
    throw new Error("dist file set differs from its clean-build manifest");
  }
  if (sha256(JSON.stringify(manifest.files)) !== manifest.artifactSetSha256) {
    throw new Error("dist artifact-set digest is invalid");
  }
  const expectedValidator = readFileSync(resolve(root, VALIDATOR_DIGEST_PATH), "utf8").trim();
  const validator = manifest.files.find(({ path }) => path === "scripts/validate-strategies.js");
  if (!SHA256.test(expectedValidator) || validator?.sha256 !== expectedValidator) {
    throw new Error("Clean build does not contain the pinned trusted validator artifact");
  }
  return { dist, manifest, expectedValidator };
}

export function writeConfigBatchAtomically(root, updates) {
  const lockPath = resolve(root, "var/validation-successors.apply.lock");
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const lock = openSync(lockPath, "wx", 0o600);
  const staged = [];
  const replaced = [];
  try {
    for (const update of updates) {
      const target = resolve(root, update.path);
      const status = lstatSync(target);
      if (!status.isFile() || status.isSymbolicLink()) {
        throw new Error(`${update.path} is not a regular config file`);
      }
      const original = readFileSync(target);
      if (sha256(original) !== update.originalSha256) {
        throw new Error(`${update.path} changed after successor verification`);
      }
      const temporary = join(
        dirname(target),
        `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`,
      );
      writeExclusive(temporary, update.content, status.mode & 0o777);
      staged.push({ ...update, target, temporary, original, mode: status.mode & 0o777 });
    }
    fsyncDirectory(resolve(root, "retailers"));
    for (const item of staged) {
      if (sha256(readFileSync(item.target)) !== item.originalSha256) {
        throw new Error(`${item.path} changed while the successor batch was staged`);
      }
      renameSync(item.temporary, item.target);
      replaced.push(item);
    }
    fsyncDirectory(resolve(root, "retailers"));
  } catch (error) {
    for (const item of [...replaced].reverse()) {
      const rollback = join(
        dirname(item.target),
        `.${basename(item.target)}.${process.pid}.${randomUUID()}.rollback`,
      );
      try {
        writeExclusive(rollback, item.original, item.mode);
        renameSync(rollback, item.target);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `Successor config batch failed and rollback failed at ${item.path}`,
        );
      }
    }
    throw error;
  } finally {
    for (const item of staged) rmSync(item.temporary, { force: true });
    closeSync(lock);
    rmSync(lockPath, { force: true });
  }
}
