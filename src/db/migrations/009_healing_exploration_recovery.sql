ALTER TABLE exploration_runs
  ADD COLUMN healing_event_id TEXT
  REFERENCES healing_events(id) ON UPDATE CASCADE ON DELETE RESTRICT;

CREATE UNIQUE INDEX exploration_runs_one_per_healing_event
  ON exploration_runs (healing_event_id)
  WHERE healing_event_id IS NOT NULL;

CREATE TRIGGER exploration_runs_healing_event_immutable
BEFORE UPDATE OF healing_event_id ON exploration_runs
WHEN NEW.healing_event_id IS NOT OLD.healing_event_id
BEGIN
  SELECT RAISE(ABORT, 'exploration run healing event identity is immutable');
END;
