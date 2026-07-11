-- Discovery has its own four-rung ladder: sitemap, API, DOM crawl, script.
-- Earlier code reused extraction's numeric mapping and therefore stored API as
-- tier 1 and DOM crawl as tier 2. Repair the derived numeric evidence while
-- retaining every immutable strategy JSON and signed validation binding.

DROP TRIGGER IF EXISTS strategies_restrict_update;
DROP TRIGGER IF EXISTS strategies_active_validation_binding_no_update;
DROP TRIGGER IF EXISTS healing_events_restrict_update;

UPDATE strategies
SET tier = CASE json_extract(strategy_json, '$.tier')
  WHEN 'sitemap' THEN 1
  WHEN 'api' THEN 2
  WHEN 'dom-crawl' THEN 3
  WHEN 'script' THEN 4
END
WHERE purpose = 'discovery'
  AND json_extract(strategy_json, '$.tier') IN ('sitemap', 'api', 'dom-crawl', 'script')
  AND tier <> CASE json_extract(strategy_json, '$.tier')
    WHEN 'sitemap' THEN 1
    WHEN 'api' THEN 2
    WHEN 'dom-crawl' THEN 3
    WHEN 'script' THEN 4
  END;

UPDATE healing_events
SET tier_from = (
  SELECT strategy.tier
  FROM strategies AS strategy
  WHERE strategy.id = healing_events.previous_strategy_id
)
WHERE purpose = 'discovery'
  AND previous_strategy_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM strategies AS strategy
    WHERE strategy.id = healing_events.previous_strategy_id
      AND strategy.tier <> healing_events.tier_from
  );

UPDATE healing_events
SET tier_to = (
  SELECT strategy.tier
  FROM strategies AS strategy
  WHERE strategy.id = healing_events.successor_strategy_id
)
WHERE purpose = 'discovery'
  AND successor_strategy_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM strategies AS strategy
    WHERE strategy.id = healing_events.successor_strategy_id
      AND strategy.tier <> healing_events.tier_to
  );

CREATE TRIGGER strategies_restrict_update
BEFORE UPDATE ON strategies
WHEN NEW.id IS NOT OLD.id
  OR NEW.retailer_id IS NOT OLD.retailer_id
  OR NEW.purpose IS NOT OLD.purpose
  OR NEW.tier IS NOT OLD.tier
  OR NEW.version IS NOT OLD.version
  OR NEW.strategy_json IS NOT OLD.strategy_json
  OR NEW.provenance IS NOT OLD.provenance
  OR NEW.model IS NOT OLD.model
  OR NEW.prompt_version IS NOT OLD.prompt_version
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'strategies immutable fields cannot be updated');
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

CREATE TRIGGER healing_events_restrict_update
BEFORE UPDATE ON healing_events
WHEN NEW.id IS NOT OLD.id
  OR NEW.retailer_id IS NOT OLD.retailer_id
  OR NEW.purpose IS NOT OLD.purpose
  OR NEW.onset_run_id IS NOT OLD.onset_run_id
  OR NEW.previous_strategy_id IS NOT OLD.previous_strategy_id
  OR NEW.category IS NOT OLD.category
  OR NEW.tier_from IS NOT OLD.tier_from
  OR NEW.drift_started_at IS NOT OLD.drift_started_at
  OR NEW.detected_at IS NOT OLD.detected_at
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'healing_events immutable fields cannot be updated');
END;
