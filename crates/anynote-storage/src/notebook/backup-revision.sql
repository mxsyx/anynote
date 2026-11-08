CREATE TABLE _backup_revision(id INTEGER PRIMARY KEY CHECK(id=1),format INTEGER NOT NULL CHECK(format=1),lineage_id TEXT NOT NULL,storage_epoch INTEGER NOT NULL CHECK(typeof(storage_epoch)='integer' AND storage_epoch>=0));
CREATE TRIGGER _backup_notebook_meta_insert AFTER INSERT ON notebook_meta BEGIN
     SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM _backup_revision WHERE id=1) THEN RAISE(ABORT,'backup revision missing') END;
     SELECT CASE WHEN (SELECT storage_epoch FROM _backup_revision WHERE id=1)>=9223372036854775807 THEN RAISE(ABORT,'backup revision exhausted') END;
     UPDATE _backup_revision SET storage_epoch=storage_epoch+1 WHERE id=1;
   END;
CREATE TRIGGER _backup_notebook_meta_update AFTER UPDATE ON notebook_meta BEGIN
     SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM _backup_revision WHERE id=1) THEN RAISE(ABORT,'backup revision missing') END;
     SELECT CASE WHEN (SELECT storage_epoch FROM _backup_revision WHERE id=1)>=9223372036854775807 THEN RAISE(ABORT,'backup revision exhausted') END;
     UPDATE _backup_revision SET storage_epoch=storage_epoch+1 WHERE id=1;
   END;
CREATE TRIGGER _backup_notebook_meta_delete AFTER DELETE ON notebook_meta BEGIN
     SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM _backup_revision WHERE id=1) THEN RAISE(ABORT,'backup revision missing') END;
     SELECT CASE WHEN (SELECT storage_epoch FROM _backup_revision WHERE id=1)>=9223372036854775807 THEN RAISE(ABORT,'backup revision exhausted') END;
     UPDATE _backup_revision SET storage_epoch=storage_epoch+1 WHERE id=1;
   END;
CREATE TRIGGER _backup_nodes_insert AFTER INSERT ON nodes BEGIN
     SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM _backup_revision WHERE id=1) THEN RAISE(ABORT,'backup revision missing') END;
     SELECT CASE WHEN (SELECT storage_epoch FROM _backup_revision WHERE id=1)>=9223372036854775807 THEN RAISE(ABORT,'backup revision exhausted') END;
     UPDATE _backup_revision SET storage_epoch=storage_epoch+1 WHERE id=1;
   END;
CREATE TRIGGER _backup_nodes_update AFTER UPDATE ON nodes BEGIN
     SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM _backup_revision WHERE id=1) THEN RAISE(ABORT,'backup revision missing') END;
     SELECT CASE WHEN (SELECT storage_epoch FROM _backup_revision WHERE id=1)>=9223372036854775807 THEN RAISE(ABORT,'backup revision exhausted') END;
     UPDATE _backup_revision SET storage_epoch=storage_epoch+1 WHERE id=1;
   END;
CREATE TRIGGER _backup_nodes_delete AFTER DELETE ON nodes BEGIN
     SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM _backup_revision WHERE id=1) THEN RAISE(ABORT,'backup revision missing') END;
     SELECT CASE WHEN (SELECT storage_epoch FROM _backup_revision WHERE id=1)>=9223372036854775807 THEN RAISE(ABORT,'backup revision exhausted') END;
     UPDATE _backup_revision SET storage_epoch=storage_epoch+1 WHERE id=1;
   END;
CREATE TRIGGER _backup_assets_insert AFTER INSERT ON assets BEGIN
     SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM _backup_revision WHERE id=1) THEN RAISE(ABORT,'backup revision missing') END;
     SELECT CASE WHEN (SELECT storage_epoch FROM _backup_revision WHERE id=1)>=9223372036854775807 THEN RAISE(ABORT,'backup revision exhausted') END;
     UPDATE _backup_revision SET storage_epoch=storage_epoch+1 WHERE id=1;
   END;
CREATE TRIGGER _backup_assets_update AFTER UPDATE ON assets BEGIN
     SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM _backup_revision WHERE id=1) THEN RAISE(ABORT,'backup revision missing') END;
     SELECT CASE WHEN (SELECT storage_epoch FROM _backup_revision WHERE id=1)>=9223372036854775807 THEN RAISE(ABORT,'backup revision exhausted') END;
     UPDATE _backup_revision SET storage_epoch=storage_epoch+1 WHERE id=1;
   END;
CREATE TRIGGER _backup_assets_delete AFTER DELETE ON assets BEGIN
     SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM _backup_revision WHERE id=1) THEN RAISE(ABORT,'backup revision missing') END;
     SELECT CASE WHEN (SELECT storage_epoch FROM _backup_revision WHERE id=1)>=9223372036854775807 THEN RAISE(ABORT,'backup revision exhausted') END;
     UPDATE _backup_revision SET storage_epoch=storage_epoch+1 WHERE id=1;
   END;
CREATE TRIGGER _backup_resources_insert AFTER INSERT ON resources BEGIN
     SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM _backup_revision WHERE id=1) THEN RAISE(ABORT,'backup revision missing') END;
     SELECT CASE WHEN (SELECT storage_epoch FROM _backup_revision WHERE id=1)>=9223372036854775807 THEN RAISE(ABORT,'backup revision exhausted') END;
     UPDATE _backup_revision SET storage_epoch=storage_epoch+1 WHERE id=1;
   END;
CREATE TRIGGER _backup_resources_update AFTER UPDATE ON resources BEGIN
     SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM _backup_revision WHERE id=1) THEN RAISE(ABORT,'backup revision missing') END;
     SELECT CASE WHEN (SELECT storage_epoch FROM _backup_revision WHERE id=1)>=9223372036854775807 THEN RAISE(ABORT,'backup revision exhausted') END;
     UPDATE _backup_revision SET storage_epoch=storage_epoch+1 WHERE id=1;
   END;
CREATE TRIGGER _backup_resources_delete AFTER DELETE ON resources BEGIN
     SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM _backup_revision WHERE id=1) THEN RAISE(ABORT,'backup revision missing') END;
     SELECT CASE WHEN (SELECT storage_epoch FROM _backup_revision WHERE id=1)>=9223372036854775807 THEN RAISE(ABORT,'backup revision exhausted') END;
     UPDATE _backup_revision SET storage_epoch=storage_epoch+1 WHERE id=1;
   END;
CREATE TRIGGER _backup_notes_insert AFTER INSERT ON notes BEGIN
     SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM _backup_revision WHERE id=1) THEN RAISE(ABORT,'backup revision missing') END;
     SELECT CASE WHEN (SELECT storage_epoch FROM _backup_revision WHERE id=1)>=9223372036854775807 THEN RAISE(ABORT,'backup revision exhausted') END;
     UPDATE _backup_revision SET storage_epoch=storage_epoch+1 WHERE id=1;
   END;
CREATE TRIGGER _backup_notes_update AFTER UPDATE ON notes BEGIN
     SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM _backup_revision WHERE id=1) THEN RAISE(ABORT,'backup revision missing') END;
     SELECT CASE WHEN (SELECT storage_epoch FROM _backup_revision WHERE id=1)>=9223372036854775807 THEN RAISE(ABORT,'backup revision exhausted') END;
     UPDATE _backup_revision SET storage_epoch=storage_epoch+1 WHERE id=1;
   END;
CREATE TRIGGER _backup_notes_delete AFTER DELETE ON notes BEGIN
     SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM _backup_revision WHERE id=1) THEN RAISE(ABORT,'backup revision missing') END;
     SELECT CASE WHEN (SELECT storage_epoch FROM _backup_revision WHERE id=1)>=9223372036854775807 THEN RAISE(ABORT,'backup revision exhausted') END;
     UPDATE _backup_revision SET storage_epoch=storage_epoch+1 WHERE id=1;
   END;
CREATE TRIGGER _backup_note_revisions_insert AFTER INSERT ON note_revisions BEGIN
     SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM _backup_revision WHERE id=1) THEN RAISE(ABORT,'backup revision missing') END;
     SELECT CASE WHEN (SELECT storage_epoch FROM _backup_revision WHERE id=1)>=9223372036854775807 THEN RAISE(ABORT,'backup revision exhausted') END;
     UPDATE _backup_revision SET storage_epoch=storage_epoch+1 WHERE id=1;
   END;
CREATE TRIGGER _backup_note_revisions_update AFTER UPDATE ON note_revisions BEGIN
     SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM _backup_revision WHERE id=1) THEN RAISE(ABORT,'backup revision missing') END;
     SELECT CASE WHEN (SELECT storage_epoch FROM _backup_revision WHERE id=1)>=9223372036854775807 THEN RAISE(ABORT,'backup revision exhausted') END;
     UPDATE _backup_revision SET storage_epoch=storage_epoch+1 WHERE id=1;
   END;
CREATE TRIGGER _backup_note_revisions_delete AFTER DELETE ON note_revisions BEGIN
     SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM _backup_revision WHERE id=1) THEN RAISE(ABORT,'backup revision missing') END;
     SELECT CASE WHEN (SELECT storage_epoch FROM _backup_revision WHERE id=1)>=9223372036854775807 THEN RAISE(ABORT,'backup revision exhausted') END;
     UPDATE _backup_revision SET storage_epoch=storage_epoch+1 WHERE id=1;
   END;
CREATE TRIGGER _backup_changes_insert AFTER INSERT ON changes BEGIN
     SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM _backup_revision WHERE id=1) THEN RAISE(ABORT,'backup revision missing') END;
     SELECT CASE WHEN (SELECT storage_epoch FROM _backup_revision WHERE id=1)>=9223372036854775807 THEN RAISE(ABORT,'backup revision exhausted') END;
     UPDATE _backup_revision SET storage_epoch=storage_epoch+1 WHERE id=1;
   END;
CREATE TRIGGER _backup_changes_update AFTER UPDATE ON changes BEGIN
     SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM _backup_revision WHERE id=1) THEN RAISE(ABORT,'backup revision missing') END;
     SELECT CASE WHEN (SELECT storage_epoch FROM _backup_revision WHERE id=1)>=9223372036854775807 THEN RAISE(ABORT,'backup revision exhausted') END;
     UPDATE _backup_revision SET storage_epoch=storage_epoch+1 WHERE id=1;
   END;
CREATE TRIGGER _backup_changes_delete AFTER DELETE ON changes BEGIN
     SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM _backup_revision WHERE id=1) THEN RAISE(ABORT,'backup revision missing') END;
     SELECT CASE WHEN (SELECT storage_epoch FROM _backup_revision WHERE id=1)>=9223372036854775807 THEN RAISE(ABORT,'backup revision exhausted') END;
     UPDATE _backup_revision SET storage_epoch=storage_epoch+1 WHERE id=1;
   END;
CREATE TRIGGER _backup_revision_resources_insert AFTER INSERT ON revision_resources BEGIN
     SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM _backup_revision WHERE id=1) THEN RAISE(ABORT,'backup revision missing') END;
     SELECT CASE WHEN (SELECT storage_epoch FROM _backup_revision WHERE id=1)>=9223372036854775807 THEN RAISE(ABORT,'backup revision exhausted') END;
     UPDATE _backup_revision SET storage_epoch=storage_epoch+1 WHERE id=1;
   END;
CREATE TRIGGER _backup_revision_resources_update AFTER UPDATE ON revision_resources BEGIN
     SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM _backup_revision WHERE id=1) THEN RAISE(ABORT,'backup revision missing') END;
     SELECT CASE WHEN (SELECT storage_epoch FROM _backup_revision WHERE id=1)>=9223372036854775807 THEN RAISE(ABORT,'backup revision exhausted') END;
     UPDATE _backup_revision SET storage_epoch=storage_epoch+1 WHERE id=1;
   END;
CREATE TRIGGER _backup_revision_resources_delete AFTER DELETE ON revision_resources BEGIN
     SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM _backup_revision WHERE id=1) THEN RAISE(ABORT,'backup revision missing') END;
     SELECT CASE WHEN (SELECT storage_epoch FROM _backup_revision WHERE id=1)>=9223372036854775807 THEN RAISE(ABORT,'backup revision exhausted') END;
     UPDATE _backup_revision SET storage_epoch=storage_epoch+1 WHERE id=1;
   END;
CREATE TRIGGER _backup_annotations_insert AFTER INSERT ON annotations BEGIN
     SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM _backup_revision WHERE id=1) THEN RAISE(ABORT,'backup revision missing') END;
     SELECT CASE WHEN (SELECT storage_epoch FROM _backup_revision WHERE id=1)>=9223372036854775807 THEN RAISE(ABORT,'backup revision exhausted') END;
     UPDATE _backup_revision SET storage_epoch=storage_epoch+1 WHERE id=1;
   END;
CREATE TRIGGER _backup_annotations_update AFTER UPDATE ON annotations BEGIN
     SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM _backup_revision WHERE id=1) THEN RAISE(ABORT,'backup revision missing') END;
     SELECT CASE WHEN (SELECT storage_epoch FROM _backup_revision WHERE id=1)>=9223372036854775807 THEN RAISE(ABORT,'backup revision exhausted') END;
     UPDATE _backup_revision SET storage_epoch=storage_epoch+1 WHERE id=1;
   END;
CREATE TRIGGER _backup_annotations_delete AFTER DELETE ON annotations BEGIN
     SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM _backup_revision WHERE id=1) THEN RAISE(ABORT,'backup revision missing') END;
     SELECT CASE WHEN (SELECT storage_epoch FROM _backup_revision WHERE id=1)>=9223372036854775807 THEN RAISE(ABORT,'backup revision exhausted') END;
     UPDATE _backup_revision SET storage_epoch=storage_epoch+1 WHERE id=1;
   END;
CREATE TRIGGER _backup_note_links_insert AFTER INSERT ON note_links BEGIN
     SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM _backup_revision WHERE id=1) THEN RAISE(ABORT,'backup revision missing') END;
     SELECT CASE WHEN (SELECT storage_epoch FROM _backup_revision WHERE id=1)>=9223372036854775807 THEN RAISE(ABORT,'backup revision exhausted') END;
     UPDATE _backup_revision SET storage_epoch=storage_epoch+1 WHERE id=1;
   END;
CREATE TRIGGER _backup_note_links_update AFTER UPDATE ON note_links BEGIN
     SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM _backup_revision WHERE id=1) THEN RAISE(ABORT,'backup revision missing') END;
     SELECT CASE WHEN (SELECT storage_epoch FROM _backup_revision WHERE id=1)>=9223372036854775807 THEN RAISE(ABORT,'backup revision exhausted') END;
     UPDATE _backup_revision SET storage_epoch=storage_epoch+1 WHERE id=1;
   END;
CREATE TRIGGER _backup_note_links_delete AFTER DELETE ON note_links BEGIN
     SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM _backup_revision WHERE id=1) THEN RAISE(ABORT,'backup revision missing') END;
     SELECT CASE WHEN (SELECT storage_epoch FROM _backup_revision WHERE id=1)>=9223372036854775807 THEN RAISE(ABORT,'backup revision exhausted') END;
     UPDATE _backup_revision SET storage_epoch=storage_epoch+1 WHERE id=1;
   END;
CREATE TRIGGER _backup_note_text_insert AFTER INSERT ON note_text BEGIN
     SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM _backup_revision WHERE id=1) THEN RAISE(ABORT,'backup revision missing') END;
     SELECT CASE WHEN (SELECT storage_epoch FROM _backup_revision WHERE id=1)>=9223372036854775807 THEN RAISE(ABORT,'backup revision exhausted') END;
     UPDATE _backup_revision SET storage_epoch=storage_epoch+1 WHERE id=1;
   END;
CREATE TRIGGER _backup_note_text_update AFTER UPDATE ON note_text BEGIN
     SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM _backup_revision WHERE id=1) THEN RAISE(ABORT,'backup revision missing') END;
     SELECT CASE WHEN (SELECT storage_epoch FROM _backup_revision WHERE id=1)>=9223372036854775807 THEN RAISE(ABORT,'backup revision exhausted') END;
     UPDATE _backup_revision SET storage_epoch=storage_epoch+1 WHERE id=1;
   END;
CREATE TRIGGER _backup_note_text_delete AFTER DELETE ON note_text BEGIN
     SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM _backup_revision WHERE id=1) THEN RAISE(ABORT,'backup revision missing') END;
     SELECT CASE WHEN (SELECT storage_epoch FROM _backup_revision WHERE id=1)>=9223372036854775807 THEN RAISE(ABORT,'backup revision exhausted') END;
     UPDATE _backup_revision SET storage_epoch=storage_epoch+1 WHERE id=1;
   END;
CREATE TRIGGER _backup_extension_data_insert AFTER INSERT ON extension_data BEGIN
     SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM _backup_revision WHERE id=1) THEN RAISE(ABORT,'backup revision missing') END;
     SELECT CASE WHEN (SELECT storage_epoch FROM _backup_revision WHERE id=1)>=9223372036854775807 THEN RAISE(ABORT,'backup revision exhausted') END;
     UPDATE _backup_revision SET storage_epoch=storage_epoch+1 WHERE id=1;
   END;
CREATE TRIGGER _backup_extension_data_update AFTER UPDATE ON extension_data BEGIN
     SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM _backup_revision WHERE id=1) THEN RAISE(ABORT,'backup revision missing') END;
     SELECT CASE WHEN (SELECT storage_epoch FROM _backup_revision WHERE id=1)>=9223372036854775807 THEN RAISE(ABORT,'backup revision exhausted') END;
     UPDATE _backup_revision SET storage_epoch=storage_epoch+1 WHERE id=1;
   END;
CREATE TRIGGER _backup_extension_data_delete AFTER DELETE ON extension_data BEGIN
     SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM _backup_revision WHERE id=1) THEN RAISE(ABORT,'backup revision missing') END;
     SELECT CASE WHEN (SELECT storage_epoch FROM _backup_revision WHERE id=1)>=9223372036854775807 THEN RAISE(ABORT,'backup revision exhausted') END;
     UPDATE _backup_revision SET storage_epoch=storage_epoch+1 WHERE id=1;
   END;
CREATE TRIGGER _backup_import_reports_insert AFTER INSERT ON import_reports BEGIN
     SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM _backup_revision WHERE id=1) THEN RAISE(ABORT,'backup revision missing') END;
     SELECT CASE WHEN (SELECT storage_epoch FROM _backup_revision WHERE id=1)>=9223372036854775807 THEN RAISE(ABORT,'backup revision exhausted') END;
     UPDATE _backup_revision SET storage_epoch=storage_epoch+1 WHERE id=1;
   END;
CREATE TRIGGER _backup_import_reports_update AFTER UPDATE ON import_reports BEGIN
     SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM _backup_revision WHERE id=1) THEN RAISE(ABORT,'backup revision missing') END;
     SELECT CASE WHEN (SELECT storage_epoch FROM _backup_revision WHERE id=1)>=9223372036854775807 THEN RAISE(ABORT,'backup revision exhausted') END;
     UPDATE _backup_revision SET storage_epoch=storage_epoch+1 WHERE id=1;
   END;
CREATE TRIGGER _backup_import_reports_delete AFTER DELETE ON import_reports BEGIN
     SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM _backup_revision WHERE id=1) THEN RAISE(ABORT,'backup revision missing') END;
     SELECT CASE WHEN (SELECT storage_epoch FROM _backup_revision WHERE id=1)>=9223372036854775807 THEN RAISE(ABORT,'backup revision exhausted') END;
     UPDATE _backup_revision SET storage_epoch=storage_epoch+1 WHERE id=1;
   END;
CREATE TRIGGER _backup_capture_receipts_insert AFTER INSERT ON capture_receipts BEGIN
     SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM _backup_revision WHERE id=1) THEN RAISE(ABORT,'backup revision missing') END;
     SELECT CASE WHEN (SELECT storage_epoch FROM _backup_revision WHERE id=1)>=9223372036854775807 THEN RAISE(ABORT,'backup revision exhausted') END;
     UPDATE _backup_revision SET storage_epoch=storage_epoch+1 WHERE id=1;
   END;
CREATE TRIGGER _backup_capture_receipts_update AFTER UPDATE ON capture_receipts BEGIN
     SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM _backup_revision WHERE id=1) THEN RAISE(ABORT,'backup revision missing') END;
     SELECT CASE WHEN (SELECT storage_epoch FROM _backup_revision WHERE id=1)>=9223372036854775807 THEN RAISE(ABORT,'backup revision exhausted') END;
     UPDATE _backup_revision SET storage_epoch=storage_epoch+1 WHERE id=1;
   END;
CREATE TRIGGER _backup_capture_receipts_delete AFTER DELETE ON capture_receipts BEGIN
     SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM _backup_revision WHERE id=1) THEN RAISE(ABORT,'backup revision missing') END;
     SELECT CASE WHEN (SELECT storage_epoch FROM _backup_revision WHERE id=1)>=9223372036854775807 THEN RAISE(ABORT,'backup revision exhausted') END;
     UPDATE _backup_revision SET storage_epoch=storage_epoch+1 WHERE id=1;
   END;