CREATE TABLE branches(notebook_id TEXT NOT NULL,lineage_id TEXT NOT NULL,head TEXT NOT NULL DEFAULT '',writer_id TEXT NOT NULL,writer_epoch INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(notebook_id,lineage_id));
CREATE TABLE generations(id TEXT PRIMARY KEY,notebook_id TEXT NOT NULL,lineage_id TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('staging','committed')),expected_head TEXT NOT NULL,writer_id TEXT NOT NULL,writer_epoch INTEGER NOT NULL,snapshot_seq INTEGER NOT NULL,manifest_hash TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX generations_scope ON generations(notebook_id,lineage_id,status,created_at);
CREATE TABLE asset_catalog(notebook_id TEXT NOT NULL,hash TEXT NOT NULL,size INTEGER NOT NULL,verified INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(notebook_id,hash));
CREATE TABLE generation_deltas(generation_id TEXT NOT NULL REFERENCES generations(id),entity_key TEXT NOT NULL,entity_table TEXT NOT NULL,object_hash TEXT,operation TEXT NOT NULL CHECK(operation IN ('upsert','delete')),PRIMARY KEY(generation_id,entity_key));
CREATE TABLE transaction_guard(id TEXT PRIMARY KEY,ok INTEGER NOT NULL CHECK(ok=1));
