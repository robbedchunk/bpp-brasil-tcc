CREATE TRIGGER strategy_validation_evidence_authorized_insert
BEFORE INSERT ON strategy_validation_evidence
WHEN validation_evidence_insert_authorized(
  NEW.strategy_id,
  NEW.receipt_path,
  NEW.receipt_sha256,
  NEW.sample_set_sha256,
  NEW.executor_json,
  NEW.attestation_key_id,
  NEW.attempted,
  NEW.valid,
  NEW.score,
  NEW.validated_at,
  NEW.recorded_at
) <> 1
BEGIN
  SELECT RAISE(ABORT, 'strategy validation evidence insert is not authorized');
END;

CREATE TRIGGER strategy_validation_evidence_requires_trusted_binding
BEFORE INSERT ON strategy_validation_evidence
WHEN
  abs(NEW.score - (CAST(NEW.valid AS REAL) / NEW.attempted)) > 0.000000000001
  OR json_extract(NEW.executor_json, '$.mode') IS NOT 'trusted-live-host'
  OR json_extract(NEW.executor_json, '$.program') IS NOT 'scripts/validate-strategies.ts'
  OR json_extract(NEW.executor_json, '$.version') IS NOT 1
  OR typeof(json_extract(NEW.executor_json, '$.runtime')) <> 'text'
  OR json_extract(NEW.executor_json, '$.runtime') NOT GLOB 'node-v24.*'
  OR typeof(json_extract(NEW.executor_json, '$.sourceCommit')) <> 'text'
  OR length(json_extract(NEW.executor_json, '$.sourceCommit')) <> 40
  OR json_extract(NEW.executor_json, '$.sourceCommit') GLOB '*[^0-9a-f]*'
  OR typeof(json_extract(NEW.executor_json, '$.playwrightVersion')) <> 'text'
  OR length(json_extract(NEW.executor_json, '$.playwrightVersion')) = 0
  OR typeof(json_extract(NEW.executor_json, '$.chromiumVersion')) <> 'text'
  OR length(json_extract(NEW.executor_json, '$.chromiumVersion')) = 0
  OR typeof(json_extract(NEW.executor_json, '$.artifactSha256')) <> 'text'
  OR length(json_extract(NEW.executor_json, '$.artifactSha256')) <> 64
  OR json_extract(NEW.executor_json, '$.artifactSha256') GLOB '*[^0-9a-f]*'
  OR json_extract(NEW.executor_json, '$.challengeAlgorithm')
       IS NOT 'active-in-scope-category-url-bucket-round-robin-v1'
  OR typeof(json_extract(NEW.executor_json, '$.sequentialPacingMs')) <> 'integer'
  OR json_extract(NEW.executor_json, '$.sequentialPacingMs') < 500
  OR typeof(json_extract(NEW.executor_json, '$.timeoutMs')) <> 'integer'
  OR json_extract(NEW.executor_json, '$.timeoutMs') <= 0
  OR typeof(json_extract(NEW.executor_json, '$.maxBodyBytes')) <> 'integer'
  OR json_extract(NEW.executor_json, '$.maxBodyBytes') <= 0
  OR typeof(json_extract(NEW.executor_json, '$.elapsedMs')) <> 'integer'
  OR json_extract(NEW.executor_json, '$.elapsedMs') < 0
  OR json_type(NEW.executor_json, '$.requestHeadersStored') IS NOT 'false'
  OR json_type(NEW.executor_json, '$.responseBodiesStored') IS NOT 'false'
  OR strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(NEW.executor_json, '$.startedAt')) IS NULL
  OR strftime('%Y-%m-%dT%H:%M:%fZ', json_extract(NEW.executor_json, '$.finishedAt')) IS NULL
  OR julianday(json_extract(NEW.executor_json, '$.finishedAt'))
       < julianday(json_extract(NEW.executor_json, '$.startedAt'))
  OR NEW.validated_at IS NOT json_extract(NEW.executor_json, '$.finishedAt')
  OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.recorded_at) IS NULL
  OR julianday(NEW.recorded_at) < julianday(NEW.validated_at)
  OR NOT EXISTS (
    SELECT 1
    FROM strategies AS strategy
    WHERE strategy.id = NEW.strategy_id
      AND strategy.active = 0
      AND NEW.receipt_path = 'data/validation/' || strategy.retailer_id || '-'
        || strategy.purpose || '-v' || strategy.version || '.json'
      AND strategy.validation_sample_size = NEW.attempted
      AND strategy.validation_successes = NEW.valid
      AND abs(strategy.validation_rate - NEW.score) <= 0.000000000001
      AND strategy.validated_at IS NEW.validated_at
  )
BEGIN
  SELECT RAISE(ABORT, 'strategy validation evidence lacks exact trusted binding');
END;

DROP TRIGGER strategies_activation_requires_validation_evidence;

CREATE TRIGGER strategies_activation_requires_validation_evidence
BEFORE UPDATE OF active ON strategies
WHEN NEW.active = 1 AND OLD.active = 0
  AND (
    NEW.retired_at IS NOT NULL
    OR NEW.activated_at IS NULL
    OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.activated_at) IS NULL
    OR julianday(NEW.activated_at) < julianday(NEW.validated_at)
    OR NOT EXISTS (
    SELECT 1
    FROM strategy_validation_evidence AS evidence
    WHERE evidence.strategy_id = NEW.id
      AND evidence.attempted = 30
      AND evidence.valid >= 27
      AND evidence.score >= 0.9
      AND abs(evidence.score - (CAST(evidence.valid AS REAL) / evidence.attempted))
        <= 0.000000000001
      AND NEW.validation_sample_size = evidence.attempted
      AND NEW.validation_successes = evidence.valid
      AND abs(NEW.validation_rate - evidence.score) <= 0.000000000001
      AND NEW.validated_at IS evidence.validated_at
  )
  )
BEGIN
  SELECT RAISE(ABORT, 'strategy activation requires exact immutable validation evidence');
END;

CREATE TRIGGER strategies_active_validation_binding_no_update
BEFORE UPDATE ON strategies
WHEN NEW.active = 1
  AND (
    NEW.retired_at IS NOT NULL
    OR NEW.activated_at IS NULL
    OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.activated_at) IS NULL
    OR julianday(NEW.activated_at) < julianday(NEW.validated_at)
    OR NOT EXISTS (
    SELECT 1
    FROM strategy_validation_evidence AS evidence
    WHERE evidence.strategy_id = NEW.id
      AND evidence.attempted = 30
      AND evidence.valid >= 27
      AND evidence.score >= 0.9
      AND abs(evidence.score - (CAST(evidence.valid AS REAL) / evidence.attempted))
        <= 0.000000000001
      AND NEW.validation_sample_size = evidence.attempted
      AND NEW.validation_successes = evidence.valid
      AND abs(NEW.validation_rate - evidence.score) <= 0.000000000001
      AND NEW.validated_at IS evidence.validated_at
  )
  )
BEGIN
  SELECT RAISE(ABORT, 'active strategy validation fields must remain evidence-bound');
END;

CREATE TRIGGER strategies_lifecycle_is_monotonic
BEFORE UPDATE ON strategies
WHEN
  (OLD.activated_at IS NOT NULL AND NEW.activated_at IS NOT OLD.activated_at)
  OR (OLD.retired_at IS NOT NULL AND NEW.retired_at IS NOT OLD.retired_at)
  OR (
    OLD.active = 1
    AND NEW.active = 0
    AND (
      NEW.retired_at IS NULL
      OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.retired_at) IS NULL
      OR julianday(NEW.retired_at) < julianday(OLD.activated_at)
    )
  )
  OR (OLD.retired_at IS NOT NULL AND NEW.active = 1)
BEGIN
  SELECT RAISE(ABORT, 'strategy activation and retirement lifecycle is monotonic');
END;
