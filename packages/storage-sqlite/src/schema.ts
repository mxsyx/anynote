/** Single-file Notebook schema. Assets are stored in bounded SQLite BLOB chunks. */
export const schema = `
CREATE TABLE notebook_meta(id TEXT PRIMARY KEY,name TEXT NOT NULL,schema_version INTEGER NOT NULL DEFAULT 3,content_seq INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
CREATE TABLE nodes(id TEXT PRIMARY KEY,parent_id TEXT REFERENCES nodes(id),kind TEXT NOT NULL CHECK(kind IN ('folder','note')),title TEXT NOT NULL,sort_key INTEGER NOT NULL,revision INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,deleted_at INTEGER,deleted_by TEXT,favorite INTEGER NOT NULL DEFAULT 0,tags TEXT NOT NULL DEFAULT '[]');
CREATE INDEX nodes_parent ON nodes(parent_id,sort_key,id);
CREATE TABLE assets(hash TEXT PRIMARY KEY,size INTEGER NOT NULL,mime TEXT NOT NULL);
CREATE TABLE resources(id TEXT PRIMARY KEY,asset_hash TEXT NOT NULL REFERENCES assets(hash),original_name TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1);
CREATE TABLE notes(node_id TEXT PRIMARY KEY REFERENCES nodes(id),note_type TEXT NOT NULL CHECK(note_type IN ('markdown','pdf','image')),head_revision_id TEXT REFERENCES note_revisions(id),primary_resource_id TEXT REFERENCES resources(id),source_uri TEXT);
CREATE TABLE note_revisions(id TEXT PRIMARY KEY,note_id TEXT NOT NULL REFERENCES notes(node_id),body TEXT NOT NULL,created_at INTEGER NOT NULL,actor TEXT NOT NULL DEFAULT 'user');
CREATE TABLE changes(seq INTEGER PRIMARY KEY AUTOINCREMENT,entity_id TEXT NOT NULL,operation TEXT NOT NULL,payload_json TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE VIRTUAL TABLE fts_notes USING fts5(note_id UNINDEXED,title,body,tokenize='trigram');
CREATE TABLE asset_chunks(asset_hash TEXT NOT NULL REFERENCES assets(hash) ON DELETE CASCADE,offset INTEGER NOT NULL CHECK(offset>=0 AND offset%1048576=0),data BLOB NOT NULL CHECK(length(data)>0 AND length(data)<=1048576),PRIMARY KEY(asset_hash,offset));
CREATE TABLE revision_resources(revision_id TEXT NOT NULL REFERENCES note_revisions(id),resource_id TEXT NOT NULL REFERENCES resources(id),asset_hash TEXT NOT NULL REFERENCES assets(hash),PRIMARY KEY(revision_id,resource_id));
CREATE TABLE annotations(id TEXT PRIMARY KEY,note_id TEXT NOT NULL REFERENCES notes(node_id),target_asset_hash TEXT NOT NULL REFERENCES assets(hash),page INTEGER NOT NULL,selector_json TEXT NOT NULL,quote TEXT NOT NULL,body TEXT NOT NULL,color TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,deleted_at INTEGER);
CREATE TABLE note_links(source_note_id TEXT NOT NULL REFERENCES notes(node_id),target_notebook_id TEXT NOT NULL,target_note_id TEXT NOT NULL,anchor TEXT,PRIMARY KEY(source_note_id,target_notebook_id,target_note_id));
CREATE TABLE note_text(note_id TEXT PRIMARY KEY REFERENCES notes(node_id),asset_hash TEXT NOT NULL REFERENCES assets(hash),body TEXT NOT NULL);
CREATE TABLE extension_data(extension_id TEXT NOT NULL,key TEXT NOT NULL,value_json TEXT NOT NULL,schema_version INTEGER NOT NULL DEFAULT 1,revision INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(extension_id,key));
CREATE TABLE import_reports(note_id TEXT PRIMARY KEY REFERENCES notes(node_id),report_json TEXT NOT NULL);
`;
