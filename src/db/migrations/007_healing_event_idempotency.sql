CREATE UNIQUE INDEX one_open_healing_event_per_retailer_purpose
  ON healing_events (retailer_id, purpose)
  WHERE status = 'open';

CREATE UNIQUE INDEX one_healing_event_per_onset_run
  ON healing_events (onset_run_id, purpose)
  WHERE onset_run_id IS NOT NULL;
