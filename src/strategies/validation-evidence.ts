import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";

import { z } from "zod";

import { redact } from "../ops/logger.js";
import { isDescriptiveProductTitle } from "../normalize/title.js";
import { VALIDATION_CHALLENGE_ALGORITHM } from "./validation-challenge.js";
import type { Strategy } from "./schema.js";
import type { ProductRef } from "./types.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u).refine(
  (value) => value !== "0".repeat(64),
  "Placeholder SHA-256 values are forbidden",
);

const ProductRefEvidenceSchema = z.object({
  canonicalUrl: z.string().url(),
  externalId: z.string().min(1).nullable(),
  sourceCategory: z.string().min(1).nullable(),
}).strict();

const RequestEvidenceSchema = z.object({
  method: z.enum(["GET", "POST"]),
  url: z.string().url(),
  bodySha256: Sha256Schema.nullable(),
}).strict();

const ResponseEvidenceSchema = z.object({
  finalUrl: z.string().url(),
  statusCode: z.number().int().min(100).max(599),
  contentType: z.string().min(1),
  bodyBytes: z.number().int().nonnegative(),
  bodySha256: Sha256Schema,
}).strict();

const NormalizedFieldsSchema = z.object({
  title: z.string().trim().min(1).refine(
    isDescriptiveProductTitle,
    "Title must contain descriptive product text",
  ),
  brand: z.string().trim().min(1).nullable(),
  price: z.number().positive().finite(),
  promoPrice: z.number().positive().finite().nullable(),
  unit: z.string().trim().min(1).nullable(),
  available: z.boolean(),
}).strict().superRefine((fields, context) => {
  if (fields.promoPrice !== null && fields.promoPrice > fields.price) {
    context.addIssue({
      code: "custom",
      path: ["promoPrice"],
      message: "Promotional price cannot exceed regular price",
    });
  }
});

const FailureEvidenceSchema = z.object({
  category: z.enum([
    "http-403",
    "http-429",
    "captcha",
    "timeout",
    "network",
    "parse",
    "missing-fields",
    "invalid-price",
    "domain-denied",
    "unknown",
  ]),
  message: z.string().trim().min(1),
  responded: z.boolean(),
  statusCode: z.number().int().min(100).max(599).nullable(),
}).strict();

const ValidationOutcomeSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("valid"),
    fields: NormalizedFieldsSchema.nullable(),
  }).strict(),
  z.object({
    status: z.literal("invalid"),
    failure: FailureEvidenceSchema,
  }).strict(),
]);

const ValidatedFactsSchema = z.object({
  returnedProductId: z.string().min(1).nullable(),
  catalogSellerId: z.string().min(1).nullable(),
  catalogSellerMatchCount: z.number().int().nonnegative().nullable(),
}).strict().superRefine((facts, context) => {
  if ((facts.catalogSellerId === null) !== (facts.catalogSellerMatchCount === null)) {
    context.addIssue({
      code: "custom",
      message: "Catalog seller identity and match count must be present together",
    });
  }
});

const ValidationSampleEvidenceSchema = z.object({
  ordinal: z.number().int().positive(),
  startedOffsetMs: z.number().int().min(0).max(3_600_000),
  durationMs: z.number().int().min(0).max(3_600_000),
  ref: ProductRefEvidenceSchema,
  refSha256: Sha256Schema,
  request: RequestEvidenceSchema,
  requestSha256: Sha256Schema,
  response: ResponseEvidenceSchema.nullable(),
  outcome: ValidationOutcomeSchema,
  outcomeSha256: Sha256Schema,
  validatedFacts: ValidatedFactsSchema,
}).strict();

const StrategyValidationEvidencePayloadSchema = z.object({
  schemaVersion: z.literal(2),
  retailerId: z.string().min(1),
  purpose: z.enum(["discovery", "extraction"]),
  strategyVersion: z.number().int().positive(),
  strategySha256: Sha256Schema,
  validatedAt: z.string().datetime(),
  executor: z.object({
    program: z.literal("scripts/validate-strategies.ts"),
    version: z.literal(1),
    mode: z.enum(["trusted-live-host", "test"]),
    runtime: z.string().regex(/^node-v24(?:\.|$)/u),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
    playwrightVersion: z.string().min(1),
    chromiumVersion: z.string().min(1),
    artifactSha256: Sha256Schema.optional(),
    challengeAlgorithm: z.literal(VALIDATION_CHALLENGE_ALGORITHM).optional(),
    sequentialPacingMs: z.number().int().min(500),
    timeoutMs: z.number().int().positive(),
    maxBodyBytes: z.number().int().positive(),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime(),
    elapsedMs: z.number().int().min(0).max(3_600_000),
    requestHeadersStored: z.literal(false),
    responseBodiesStored: z.literal(false),
  }).strict(),
  attempted: z.number().int().nonnegative(),
  valid: z.number().int().nonnegative(),
  score: z.number().min(0).max(1),
  activatable: z.boolean(),
  sampleSetSha256: Sha256Schema,
  samples: z.array(ValidationSampleEvidenceSchema),
}).strict();

const ValidationAttestationSchema = z.object({
  algorithm: z.literal("ed25519"),
  keyId: Sha256Schema,
  payloadSha256: Sha256Schema,
  signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/u),
}).strict();

export const StrategyValidationEvidenceSchema = StrategyValidationEvidencePayloadSchema.extend({
  attestation: ValidationAttestationSchema,
}).strict();

export type StrategyValidationEvidencePayload = z.infer<
  typeof StrategyValidationEvidencePayloadSchema
>;

export type StrategyValidationEvidence = z.infer<
  typeof StrategyValidationEvidenceSchema
>;

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, child]) => [key, canonicalValue(child)]));
  }
  return value;
}

export function canonicalEvidenceJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function evidenceValueSha256(value: unknown): string {
  return createHash("sha256").update(canonicalEvidenceJson(value)).digest("hex");
}

function verificationKey(key: KeyObject): KeyObject {
  return key.type === "public" ? key : createPublicKey(key);
}

export function validationAttestationKeyId(key: KeyObject): string {
  const der = verificationKey(key).export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex");
}

function evidencePayload(
  evidence: StrategyValidationEvidence,
): StrategyValidationEvidencePayload {
  const { attestation: _attestation, ...payload } = evidence;
  return StrategyValidationEvidencePayloadSchema.parse(payload);
}

export function attestStrategyValidationEvidence(
  input: unknown,
  privateKey: KeyObject,
): StrategyValidationEvidence {
  if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Validation signing key must be an Ed25519 private key");
  }
  const payload = StrategyValidationEvidencePayloadSchema.parse(input);
  const canonical = canonicalEvidenceJson(payload);
  const payloadSha256 = createHash("sha256").update(canonical).digest("hex");
  const signature = sign(null, Buffer.from(canonical), privateKey).toString("base64");
  return StrategyValidationEvidenceSchema.parse({
    ...payload,
    attestation: {
      algorithm: "ed25519",
      keyId: validationAttestationKeyId(privateKey),
      payloadSha256,
      signature,
    },
  });
}

export function verifyStrategyValidationAttestation(
  evidence: StrategyValidationEvidence,
  publicKey: KeyObject,
): void {
  if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Validation verification key must be an Ed25519 public key");
  }
  const payload = evidencePayload(evidence);
  const canonical = canonicalEvidenceJson(payload);
  const payloadSha256 = createHash("sha256").update(canonical).digest("hex");
  if (
    evidence.attestation.keyId !== validationAttestationKeyId(publicKey)
    || evidence.attestation.payloadSha256 !== payloadSha256
    || !verify(
      null,
      Buffer.from(canonical),
      publicKey,
      Buffer.from(evidence.attestation.signature, "base64"),
    )
  ) {
    throw new Error("Validation evidence host attestation is invalid");
  }
}

export function validationReceiptSha256(evidence: StrategyValidationEvidence): string {
  return evidenceValueSha256(evidence);
}

export function readValidationSigningPrivateKey(path: string): KeyObject {
  const stat = lstatSync(path);
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) {
    throw new Error("Validation signing key must be a regular mode-0600 file");
  }
  const key = createPrivateKey(readFileSync(path));
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("Validation signing key must be Ed25519");
  }
  return key;
}

export function readValidationVerificationPublicKey(path: string): KeyObject {
  const stat = lstatSync(path);
  if (!stat.isFile()) {
    throw new Error("Validation verification key must be a regular file");
  }
  const key = createPublicKey(readFileSync(path));
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("Validation verification key must be Ed25519");
  }
  return key;
}

export function readTrustedValidatorArtifactSha256(
  path = new URL("../../ops/validator-bundle.sha256", import.meta.url).pathname,
): string {
  const stat = lstatSync(path);
  if (!stat.isFile()) {
    throw new Error("Trusted validator artifact digest must be a regular file");
  }
  const digest = readFileSync(path, "utf8").trim();
  if (!/^[a-f0-9]{64}$/u.test(digest) || digest === "0".repeat(64)) {
    throw new Error("Trusted validator artifact digest is malformed");
  }
  return digest;
}

export function strategyEvidenceSha256(strategy: Strategy): string {
  return evidenceValueSha256(strategy);
}

export function validationRefSha256(ref: ProductRef): string {
  return evidenceValueSha256({
    canonicalUrl: ref.canonicalUrl,
    externalId: ref.externalId,
    sourceCategory: ref.sourceCategory,
  });
}

export function validationSampleSetSha256(
  samples: StrategyValidationEvidence["samples"],
): string {
  return evidenceValueSha256(samples.map((sample) => ({
    ordinal: sample.ordinal,
    startedOffsetMs: sample.startedOffsetMs,
    durationMs: sample.durationMs,
    refSha256: sample.refSha256,
    requestSha256: sample.requestSha256,
    responseSha256: sample.response?.bodySha256 ?? null,
    outcomeSha256: sample.outcomeSha256,
  })));
}

function urlAllowed(url: string, allowedDomains: readonly string[]): boolean {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") {
    return false;
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.+$/u, "");
  const sensitiveQueryKey = /(?:^|[_-])(?:access[_-]?token|api[_-]?key|auth(?:orization|entication)?|cookie|credential|key|password|private[_-]?key|secret|session(?:[_-]?(?:id|token))?|sig(?:nature)?|token)(?:$|[_-])/iu;
  if ([...parsed.searchParams.keys()].some((key) => sensitiveQueryKey.test(key))) {
    return false;
  }
  return allowedDomains.some((domain) => {
    const candidate = domain.trim().toLowerCase().replace(/\.+$/u, "");
    return candidate !== ""
      && (hostname === candidate || hostname.endsWith(`.${candidate}`));
  });
}

function authoritativeRefKey(ref: ProductRef): string {
  return canonicalEvidenceJson({
    canonicalUrl: ref.canonicalUrl,
    externalId: ref.externalId,
    sourceCategory: ref.sourceCategory,
  });
}

export function validateStrategyEvidence(
  input: unknown,
  expected: {
    retailerId: string;
    purpose: "discovery" | "extraction";
    strategyVersion: number;
    strategy: Strategy;
    verificationPublicKey: KeyObject;
    authoritativeRefs?: readonly ProductRef[];
  },
): StrategyValidationEvidence {
  const evidence = StrategyValidationEvidenceSchema.parse(input);
  verifyStrategyValidationAttestation(evidence, expected.verificationPublicKey);
  if (
    evidence.retailerId !== expected.retailerId
    || evidence.purpose !== expected.purpose
    || evidence.strategyVersion !== expected.strategyVersion
    || evidence.strategySha256 !== strategyEvidenceSha256(expected.strategy)
  ) {
    throw new Error("Validation evidence does not bind the expected strategy identity");
  }
  if (evidence.samples.length !== evidence.attempted) {
    throw new Error("Validation evidence sample count does not match attempted");
  }
  const refHashes = new Set<string>();
  const canonicalUrls = new Set<string>();
  const authoritative = expected.authoritativeRefs === undefined
    ? null
    : new Set(expected.authoritativeRefs.map(authoritativeRefKey));
  const regional = expected.strategy.purpose === "extraction"
    && expected.strategy.tier === "api"
    ? expected.strategy.regionalContext
    : undefined;
  if (evidence.executor.finishedAt !== evidence.validatedAt) {
    throw new Error("Validation evidence completion time must equal validatedAt");
  }
  const wallElapsed = Date.parse(evidence.executor.finishedAt)
    - Date.parse(evidence.executor.startedAt);
  if (
    wallElapsed < 0
    || Math.abs(wallElapsed - evidence.executor.elapsedMs) > 1_000
  ) {
    throw new Error("Validation evidence elapsed time does not match its execution window");
  }
  const attemptsByOffset = new Map<number, string>();

  evidence.samples.forEach((sample, index) => {
    if (sample.ordinal !== index + 1) {
      throw new Error("Validation evidence ordinals must be contiguous and ordered");
    }
    if (sample.startedOffsetMs + sample.durationMs > evidence.executor.elapsedMs + 1_000) {
      throw new Error("Validation sample timing exceeds the execution window");
    }
    const attemptIdentity = canonicalEvidenceJson({
      requestSha256: sample.requestSha256,
      response: sample.response,
    });
    const existingAttempt = attemptsByOffset.get(sample.startedOffsetMs);
    if (existingAttempt !== undefined && existingAttempt !== attemptIdentity) {
      throw new Error("Distinct validation attempts cannot share a start offset");
    }
    attemptsByOffset.set(sample.startedOffsetMs, attemptIdentity);
    if (!urlAllowed(sample.ref.canonicalUrl, expected.strategy.allowedDomains)
      || !urlAllowed(sample.request.url, expected.strategy.allowedDomains)
      || (sample.response !== null
        && !urlAllowed(sample.response.finalUrl, expected.strategy.allowedDomains))) {
      throw new Error("Validation evidence contains a URL outside the strategy allowlist");
    }
    if (sample.refSha256 !== validationRefSha256(sample.ref)) {
      throw new Error("Validation evidence reference hash is not derived from its reference");
    }
    if (sample.requestSha256 !== evidenceValueSha256(sample.request)) {
      throw new Error("Validation evidence request hash is not derived from its request");
    }
    if (sample.outcomeSha256 !== evidenceValueSha256(sample.outcome)) {
      throw new Error("Validation evidence outcome hash is not derived from its outcome");
    }
    if (refHashes.has(sample.refSha256) || canonicalUrls.has(sample.ref.canonicalUrl)) {
      throw new Error("Validation evidence contains duplicate sample references");
    }
    refHashes.add(sample.refSha256);
    canonicalUrls.add(sample.ref.canonicalUrl);
    if (authoritative !== null && !authoritative.has(authoritativeRefKey(sample.ref))) {
      throw new Error("Validation evidence sample is absent from authoritative product references");
    }
    if (sample.outcome.status === "valid") {
      if (
        sample.response === null
        || sample.response.statusCode < 200
        || sample.response.statusCode >= 300
      ) {
        throw new Error("A valid sample requires a successful HTTP response");
      }
      if (expected.purpose === "extraction" && sample.outcome.fields === null) {
        throw new Error("A valid extraction sample requires normalized fields");
      }
      if (expected.purpose === "discovery" && sample.outcome.fields !== null) {
        throw new Error("Discovery receipts cannot claim extraction fields");
      }
    } else {
      const { failure } = sample.outcome;
      if (redact(failure.message) !== failure.message) {
        throw new Error("Validation failure message contains secret-shaped evidence");
      }
      if (failure.responded !== (sample.response !== null)) {
        throw new Error("Failure response evidence does not match its responded flag");
      }
      if (
        sample.response !== null
        && failure.statusCode !== null
        && failure.statusCode !== sample.response.statusCode
      ) {
        throw new Error("Failure status code does not match its response evidence");
      }
    }
    if (sample.response === null) {
      if (
        sample.validatedFacts.returnedProductId !== null
        || sample.validatedFacts.catalogSellerId !== null
        || sample.validatedFacts.catalogSellerMatchCount !== null
      ) {
        throw new Error("A non-responded sample cannot claim returned response facts");
      }
    } else if (
      sample.validatedFacts.returnedProductId !== null
      && sample.ref.externalId !== null
      && sample.validatedFacts.returnedProductId !== sample.ref.externalId
    ) {
      throw new Error("Validation evidence returned product identity does not match its reference");
    }
    if (
      expected.purpose === "extraction"
      &&
      sample.outcome.status === "valid"
      && sample.ref.externalId !== null
      && sample.validatedFacts.returnedProductId !== sample.ref.externalId
    ) {
      throw new Error("A valid sample must prove the exact returned product identity");
    }
    if (
      regional?.catalogSellerId !== undefined
      && sample.response !== null
      && (
        sample.outcome.status === "valid"
        || sample.validatedFacts.catalogSellerId !== null
        || sample.validatedFacts.catalogSellerMatchCount !== null
      )
    ) {
      if (
        sample.validatedFacts.catalogSellerId !== regional.catalogSellerId
        || sample.validatedFacts.catalogSellerMatchCount !== 1
      ) {
        throw new Error("Validation evidence does not prove the exact regional catalog seller");
      }
    } else if (regional?.catalogSellerId === undefined && (
      sample.validatedFacts.catalogSellerId !== null
      || sample.validatedFacts.catalogSellerMatchCount !== null
    )) {
      throw new Error("Non-regional evidence cannot claim a catalog seller binding");
    }
  });

  const attemptOffsets = [...attemptsByOffset.keys()].sort((left, right) => left - right);
  for (let index = 1; index < attemptOffsets.length; index += 1) {
    const previous = attemptOffsets[index - 1];
    const current = attemptOffsets[index];
    if (
      previous === undefined
      || current === undefined
      || current - previous < evidence.executor.sequentialPacingMs
    ) {
      throw new Error("Validation request starts violate sequential pacing");
    }
  }

  const valid = evidence.samples.filter((sample) => sample.outcome.status === "valid").length;
  const score = evidence.attempted === 0 ? 0 : valid / evidence.attempted;
  const activatable = evidence.executor.mode === "trusted-live-host"
    && evidence.attempted === 30
    && score >= 0.9;
  if (
    evidence.valid !== valid
    || evidence.score !== score
    || evidence.activatable !== activatable
  ) {
    throw new Error("Validation evidence aggregate does not match its samples");
  }
  if (evidence.sampleSetSha256 !== validationSampleSetSha256(evidence.samples)) {
    throw new Error("Validation evidence sample-set hash is invalid");
  }
  return evidence;
}

export function readStrategyValidationEvidence(
  path: string,
  expected: Parameters<typeof validateStrategyEvidence>[1],
): StrategyValidationEvidence {
  return validateStrategyEvidence(JSON.parse(readFileSync(path, "utf8")), expected);
}
