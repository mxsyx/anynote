export const upgradeSQL = `
ALTER TABLE notes ADD COLUMN source_uri TEXT;
ALTER TABLE resources ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
CREATE TABLE revision_resources(revision_id TEXT NOT NULL REFERENCES note_revisions(id),resource_id TEXT NOT NULL REFERENCES resources(id),asset_hash TEXT NOT NULL REFERENCES assets(hash),PRIMARY KEY(revision_id,resource_id));
CREATE TABLE annotations(id TEXT PRIMARY KEY,note_id TEXT NOT NULL REFERENCES notes(node_id),target_asset_hash TEXT NOT NULL REFERENCES assets(hash),page INTEGER NOT NULL,selector_json TEXT NOT NULL,quote TEXT NOT NULL,body TEXT NOT NULL,color TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,deleted_at INTEGER);
CREATE TABLE note_links(source_note_id TEXT NOT NULL REFERENCES notes(node_id),target_notebook_id TEXT NOT NULL,target_note_id TEXT NOT NULL,anchor TEXT,PRIMARY KEY(source_note_id,target_notebook_id,target_note_id));
CREATE TABLE note_text(note_id TEXT PRIMARY KEY REFERENCES notes(node_id),asset_hash TEXT NOT NULL REFERENCES assets(hash),body TEXT NOT NULL);
CREATE TABLE extension_data(extension_id TEXT NOT NULL,key TEXT NOT NULL,value_json TEXT NOT NULL,schema_version INTEGER NOT NULL DEFAULT 1,revision INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(extension_id,key));
CREATE TABLE import_reports(note_id TEXT PRIMARY KEY REFERENCES notes(node_id),report_json TEXT NOT NULL);
UPDATE notebook_meta SET schema_version=2;
`;
