CREATE TRIGGER IF NOT EXISTS strategies_no_delete
BEFORE DELETE ON strategies
BEGIN
  SELECT RAISE(ABORT, 'strategies is append-only');
END;

CREATE TRIGGER IF NOT EXISTS runs_no_delete
BEFORE DELETE ON runs
BEGIN
  SELECT RAISE(ABORT, 'runs is append-only');
END;

CREATE TRIGGER IF NOT EXISTS observations_no_delete
BEFORE DELETE ON observations
BEGIN
  SELECT RAISE(ABORT, 'observations is append-only');
END;

CREATE TRIGGER IF NOT EXISTS run_failures_no_delete
BEFORE DELETE ON run_failures
BEGIN
  SELECT RAISE(ABORT, 'run_failures is append-only');
END;

CREATE TRIGGER IF NOT EXISTS classifications_no_delete
BEFORE DELETE ON classifications
BEGIN
  SELECT RAISE(ABORT, 'classifications is append-only');
END;

CREATE TRIGGER IF NOT EXISTS exploration_runs_no_delete
BEFORE DELETE ON exploration_runs
BEGIN
  SELECT RAISE(ABORT, 'exploration_runs is append-only');
END;

CREATE TRIGGER IF NOT EXISTS healing_events_no_delete
BEFORE DELETE ON healing_events
BEGIN
  SELECT RAISE(ABORT, 'healing_events is append-only');
END;

CREATE TRIGGER IF NOT EXISTS heartbeats_no_delete
BEFORE DELETE ON heartbeats
BEGIN
  SELECT RAISE(ABORT, 'heartbeats is append-only');
END;

CREATE TRIGGER IF NOT EXISTS cost_ledger_no_delete
BEFORE DELETE ON cost_ledger
BEGIN
  SELECT RAISE(ABORT, 'cost_ledger is append-only');
END;

CREATE TRIGGER IF NOT EXISTS observations_no_update
BEFORE UPDATE ON observations
BEGIN
  SELECT RAISE(ABORT, 'observations is immutable');
END;

CREATE TRIGGER IF NOT EXISTS run_failures_no_update
BEFORE UPDATE ON run_failures
BEGIN
  SELECT RAISE(ABORT, 'run_failures is immutable');
END;

CREATE TRIGGER IF NOT EXISTS classifications_no_update
BEFORE UPDATE ON classifications
BEGIN
  SELECT RAISE(ABORT, 'classifications is immutable');
END;

CREATE TRIGGER IF NOT EXISTS heartbeats_no_update
BEFORE UPDATE ON heartbeats
BEGIN
  SELECT RAISE(ABORT, 'heartbeats is immutable');
END;

CREATE TRIGGER IF NOT EXISTS cost_ledger_no_update
BEFORE UPDATE ON cost_ledger
BEGIN
  SELECT RAISE(ABORT, 'cost_ledger is immutable');
END;

CREATE TRIGGER IF NOT EXISTS strategies_restrict_update
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

CREATE TRIGGER IF NOT EXISTS runs_restrict_update
BEFORE UPDATE ON runs
WHEN NEW.id IS NOT OLD.id
  OR NEW.retailer_id IS NOT OLD.retailer_id
  OR NEW.stage IS NOT OLD.stage
  OR NEW.collection_day IS NOT OLD.collection_day
  OR NEW.strategy_id IS NOT OLD.strategy_id
  OR NEW.strategy_version IS NOT OLD.strategy_version
  OR NEW.started_at IS NOT OLD.started_at
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'runs immutable fields cannot be updated');
END;

CREATE TRIGGER IF NOT EXISTS exploration_runs_restrict_update
BEFORE UPDATE ON exploration_runs
WHEN NEW.id IS NOT OLD.id
  OR NEW.retailer_id IS NOT OLD.retailer_id
  OR NEW.purpose IS NOT OLD.purpose
  OR NEW.trigger IS NOT OLD.trigger
  OR NEW.previous_strategy_id IS NOT OLD.previous_strategy_id
  OR NEW.event_budget IS NOT OLD.event_budget
  OR NEW.sandbox_id IS NOT OLD.sandbox_id
  OR NEW.started_at IS NOT OLD.started_at
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'exploration_runs immutable fields cannot be updated');
END;

CREATE TRIGGER IF NOT EXISTS healing_events_restrict_update
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
