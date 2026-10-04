CREATE TABLE notebook_state(notebook_id TEXT PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 0,maintenance_id TEXT);
CREATE TABLE writer_claims(id TEXT PRIMARY KEY,notebook_id TEXT NOT NULL,lineage_id TEXT NOT NULL,device_id TEXT NOT NULL,expected_epoch INTEGER NOT NULL,expected_head TEXT NOT NULL,new_epoch INTEGER NOT NULL);
CREATE TABLE retired_generations(id TEXT PRIMARY KEY,notebook_id TEXT NOT NULL,plan_id TEXT NOT NULL);
CREATE TABLE retention_plans(id TEXT PRIMARY KEY,notebook_id TEXT NOT NULL,lineage_id TEXT NOT NULL,writer_id TEXT NOT NULL,writer_epoch INTEGER NOT NULL,state_revision INTEGER NOT NULL,body_json TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'planned',created_at INTEGER NOT NULL,object_cursor INTEGER NOT NULL DEFAULT 0,generation_cursor INTEGER NOT NULL DEFAULT 0,execution_id TEXT);
CREATE TABLE restore_pins(id TEXT PRIMARY KEY,notebook_id TEXT NOT NULL,generation_id TEXT NOT NULL,expires_at INTEGER NOT NULL);
CREATE INDEX restore_pins_scope ON restore_pins(notebook_id,expires_at);
