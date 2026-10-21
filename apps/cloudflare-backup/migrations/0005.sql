ALTER TABLE notebook_state ADD COLUMN maintenance_epoch INTEGER NOT NULL DEFAULT 0;
CREATE TABLE generation_activity(id TEXT PRIMARY KEY, touched_at INTEGER NOT NULL);
INSERT INTO generation_activity SELECT id,CAST(strftime('%s','now') AS INTEGER)*1000 FROM generations WHERE status='staging';
CREATE INDEX retention_plans_scope ON retention_plans(notebook_id,status,created_at);
CREATE INDEX retired_generations_scope ON retired_generations(notebook_id);
CREATE INDEX writer_claims_scope ON writer_claims(notebook_id);
