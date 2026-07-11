CREATE TABLE retailer_state_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  retailer_id TEXT NOT NULL
    REFERENCES retailers(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  healing_event_id TEXT
    REFERENCES healing_events(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  purpose TEXT CHECK (purpose IS NULL OR purpose IN ('discovery', 'extraction')),
  state TEXT NOT NULL CHECK (state IN ('degraded', 'recovered')),
  reason TEXT,
  source TEXT NOT NULL CHECK (
    source IN (
      'migration_backfill', 'retailer_insert', 'retailer_transition',
      'healing_transition'
    )
  ),
  effective_at TEXT NOT NULL CHECK (
    strftime('%Y-%m-%dT%H:%M:%fZ', effective_at) IS NOT NULL
    AND effective_at = strftime('%Y-%m-%dT%H:%M:%fZ', effective_at)
  ),
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (
    (healing_event_id IS NULL AND purpose IS NULL)
    OR (healing_event_id IS NOT NULL AND purpose IS NOT NULL)
  ),
  CHECK (state = 'degraded' OR reason IS NULL)
) STRICT;

CREATE INDEX retailer_state_events_by_retailer_time
  ON retailer_state_events (retailer_id, effective_at DESC, sequence DESC);

CREATE INDEX retailer_state_events_by_healing
  ON retailer_state_events (healing_event_id)
  WHERE healing_event_id IS NOT NULL;

-- The mutable retailer flag predates temporal evidence. Preserve the best
-- boundary available at migration time without projecting current state into
-- earlier collection runs: healthy retailers are healthy from creation, while
-- a currently degraded retailer becomes degraded only at its last state write.
INSERT INTO retailer_state_events
  (retailer_id, state, reason, source, effective_at)
SELECT id,
       CASE WHEN degraded = 1 THEN 'degraded' ELSE 'recovered' END,
       CASE WHEN degraded = 1 THEN degraded_reason ELSE NULL END,
       'migration_backfill',
       CASE WHEN degraded = 1 THEN updated_at ELSE created_at END
FROM retailers
ORDER BY id;

CREATE TRIGGER retailer_state_events_after_retailer_insert
AFTER INSERT ON retailers
BEGIN
  INSERT INTO retailer_state_events
    (retailer_id, state, reason, source, effective_at)
  VALUES (
    NEW.id,
    CASE WHEN NEW.degraded = 1 THEN 'degraded' ELSE 'recovered' END,
    CASE WHEN NEW.degraded = 1 THEN NEW.degraded_reason ELSE NULL END,
    'retailer_insert',
    NEW.created_at
  );
END;

CREATE TRIGGER retailer_state_events_after_state_change
AFTER UPDATE OF degraded ON retailers
WHEN NEW.degraded IS NOT OLD.degraded
BEGIN
  INSERT INTO retailer_state_events
    (retailer_id, state, reason, source, effective_at)
  SELECT NEW.id,
         CASE WHEN NEW.degraded = 1 THEN 'degraded' ELSE 'recovered' END,
         CASE WHEN NEW.degraded = 1 THEN NEW.degraded_reason ELSE NULL END,
         'retailer_transition',
         NEW.updated_at
  WHERE NOT EXISTS (
    SELECT 1
    FROM retailer_state_events event
    WHERE event.retailer_id = NEW.id
      AND event.state = CASE WHEN NEW.degraded = 1 THEN 'degraded' ELSE 'recovered' END
      AND event.effective_at = NEW.updated_at
  );
END;

CREATE TRIGGER retailer_state_events_no_update
BEFORE UPDATE ON retailer_state_events
BEGIN
  SELECT RAISE(ABORT, 'retailer state events are immutable');
END;

CREATE TRIGGER retailer_state_events_no_delete
BEFORE DELETE ON retailer_state_events
BEGIN
  SELECT RAISE(ABORT, 'retailer state events are append-only');
END;
