CREATE TABLE multipart_sessions (
  upload_id TEXT PRIMARY KEY,
  notebook_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX multipart_sessions_book ON multipart_sessions(notebook_id, generation_id);
