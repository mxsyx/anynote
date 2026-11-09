use anynote_core::{asset::AssetScope, document_session::DocumentId, image::ImageRect, pdf::*};
use anynote_storage::notebook::*;
use uuid::Uuid;
fn scope(book: &str, note: &Note, resource: Uuid) -> AssetScope {
    AssetScope::new(
        DocumentId::new(
            Uuid::parse_str(book).unwrap(),
            Uuid::parse_str(&note.node.id).unwrap(),
        ),
        Uuid::parse_str(note.head_revision_id.as_ref().unwrap()).unwrap(),
        resource,
    )
}
#[test]
fn annotations_index_history_replacement_reanchor_and_reading_links() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tmp/rm26/storage");
    std::fs::create_dir_all(&root).unwrap();
    let temp = tempfile::tempdir_in(root.canonicalize().unwrap()).unwrap();
    let queue = WriteQueue::open(temp.path(), 4).unwrap();
    queue.submit(|catalog| {
        let book=catalog.create_notebook("PDF")?.id;let b=catalog.notebook(&book)?;
        let resource=Uuid::new_v4();let mut request=CreateNode::note("PDF","");request.note_type=Some(NoteType::Pdf);request.primary_resource_id=Some(resource.to_string());
        let bytes=std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/pdf/w3c-dummy.pdf")).unwrap();
        let note=b.create_node(&request,&[ResourceWrite::bytes(resource.to_string(),"a.pdf".into(),"application/pdf".into(),bytes.clone())?])?;
        let old=scope(&book,&note,resource);let hash=b.read().resource(&resource.to_string(),Some(ResourceScope::note(&note.node.id)))?.info().hash.clone();
        let draft=AnnotationDraft::new(1,vec![ImageRect {x:0.1,y:0.2,width:0.2,height:0.1}],"quotation".into(),"remark needle".into());
        let PdfReply::Annotation {id}=b.execute_pdf(PdfCommand::Annotate {scope:old.clone(),hash:hash.clone(),draft:draft.clone()})? else {panic!()};
        let PdfReply::Note {document}=b.execute_pdf(PdfCommand::ReadingNote {scope:old.clone(),hash:hash.clone(),draft,annotation:Some(id)})? else {panic!()};
        assert!(b.read().note(&document.note().to_string())?.body.contains(&format!("#pdf-annotation-{id}")));
        let mut index=IndexBuilder::new(1).unwrap();index.push(0,"searchable native text".into(),false);let (body,coverage)=index.finish().unwrap();
        b.publish_pdf_index(&old,&hash,&body,&coverage)?;
        let mut query=SearchRequest::new(Uuid::new_v4().to_string(),"native".into());query.limit=10;
        let found=b.read().search(&query)?;assert_eq!(found.results.len(),1);assert!(matches!(found.results[0].location,Some(SearchLocation::Pdf {ref anchor}) if anchor=="pdf-page-1"));
        let mut changed=bytes;changed.extend_from_slice(b"\n% new resource\n");
        let new=b.save_note(&note.node.id,note.node.revision,&NotePatch::default(),&[ResourceWrite::bytes(resource.to_string(),"b.pdf".into(),"application/pdf".into(),changed)?])?;
        let current=scope(&book,&new,resource);let new_hash=b.read().resource(&resource.to_string(),Some(ResourceScope::note(&note.node.id)))?.info().hash.clone();assert_ne!(hash,new_hash);
        assert!(b.publish_pdf_index(&old,&hash,&body,&coverage).is_err());
        assert!(b.execute_pdf(PdfCommand::Reanchor {scope:old.clone(),hash:hash.clone()}).is_err());
        let PdfReply::Loaded {annotations,current:is_current,coverage}=b.execute_pdf(PdfCommand::Load {scope:current.clone(),hash:new_hash.clone()})? else {panic!()};
        assert!(is_current);assert!(coverage.is_none());assert_eq!(annotations[0].hash(),hash);
        assert!(b.read().search(&query)?.results.is_empty());
        b.execute_pdf(PdfCommand::Reanchor {scope:current.clone(),hash:new_hash.clone()})?;
        assert_eq!(b.read().annotations(&note.node.id,false)?[0].target_asset_hash,new_hash);
        b.execute_pdf(PdfCommand::Delete {scope:current,hash:new_hash,annotation:id})?;assert!(b.read().annotations(&note.node.id,false)?.is_empty());
        let PdfReply::Loaded {current:is_current,..}=b.execute_pdf(PdfCommand::Load {scope:old,hash})? else {panic!()};assert!(!is_current);
        assert_eq!(b.read().history(&note.node.id)?.len(),2);
        Ok(())
    }).unwrap().wait().unwrap();
}

#[test]
fn copied_pdf_keeps_index_annotation_links_and_snapshot_assets() {
    use anynote_storage::notebook::transfer::*;
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tmp/rm26/closure");
    std::fs::create_dir_all(&root).unwrap();
    let root = root.canonicalize().unwrap();
    let temp = tempfile::tempdir_in(&root).unwrap();
    let queue = WriteQueue::open(temp.path(), 4).unwrap();
    queue
        .submit(move |catalog| {
            let source = catalog.create_notebook("source")?.id;
            let target = catalog.create_notebook("target")?.id;
            let b = catalog.notebook(&source)?;
            let mut folder = CreateNode::note("Reading", "");
            folder.kind = NodeKind::Folder;
            folder.note_type = None;
            let folder = b.create_node(&folder, &[])?;
            let resource = Uuid::new_v4();
            let mut request = CreateNode::note("PDF", "");
            request.note_type = Some(NoteType::Pdf);
            request.primary_resource_id = Some(resource.to_string());
            request.parent_id = Some(folder.node.id.clone());
            let bytes = std::fs::read(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../tests/fixtures/pdf/w3c-dummy.pdf"),
            )
            .unwrap();
            let note = b.create_node(
                &request,
                &[ResourceWrite::bytes(
                    resource.to_string(),
                    "a.pdf".into(),
                    "application/pdf".into(),
                    bytes,
                )?],
            )?;
            let scoped = scope(&source, &note, resource);
            let hash = b
                .read()
                .resource(
                    &resource.to_string(),
                    Some(ResourceScope::note(&note.node.id)),
                )?
                .info()
                .hash
                .clone();
            let draft = AnnotationDraft::new(
                1,
                vec![ImageRect {
                    x: 0.1,
                    y: 0.1,
                    width: 0.2,
                    height: 0.1,
                }],
                "Dummy PDF file".into(),
                "comment".into(),
            );
            let PdfReply::Annotation { id: annotation } = b.execute_pdf(PdfCommand::Annotate {
                scope: scoped.clone(),
                hash: hash.clone(),
                draft: draft.clone(),
            })?
            else {
                panic!()
            };
            let PdfReply::Note { document } = b.execute_pdf(PdfCommand::ReadingNote {
                scope: scoped.clone(),
                hash: hash.clone(),
                draft,
                annotation: Some(annotation),
            })?
            else {
                panic!()
            };
            b.move_node(&document.note().to_string(), Some(&folder.node.id))?;
            let mut index = IndexBuilder::new(1).unwrap();
            index.push(0, "Dummy PDF file".into(), false);
            let (body, coverage) = index.finish().unwrap();
            b.publish_pdf_index(&scoped, &hash, &body, &coverage)?;
            let request = TransferRequest {
                notebook_id: source.clone(),
                target_notebook_id: target.clone(),
                id: folder.node.id,
                target_parent_id: None,
                mode: TransferMode::Copy,
                operation_id: Uuid::new_v4().to_string(),
                expected_revision: 1,
            };
            let copied = catalog.with_pair(&source, &target, |a, b| {
                Ok(b.copy_transfer(a, &request)?.result())
            })?;
            let new_note = &copied.node_map[&note.node.id];
            let new_reading = &copied.node_map[&document.note().to_string()];
            let b = catalog.notebook(&target)?;
            let annotations = b.read().annotations(new_note, false)?;
            assert_eq!(annotations.len(), 1);
            assert_ne!(annotations[0].id, annotation.to_string());
            assert!(b.read().note(new_reading)?.body.contains(&format!(
                "anynote://notebook/{target}/note/{new_note}#pdf-annotation-{}",
                annotations[0].id
            )));
            assert_eq!(
                b.read().pdf_coverage(new_note, &hash)?.unwrap().state(),
                IndexState::Complete
            );
            let mut frozen = catalog.capture_snapshot(&target, &root, &Cancellation::default())?;
            frozen.prepare(SnapshotMode::Full, &Cancellation::default())?;
            let reader = ReadonlyNotebook::open(frozen.path(), Some(&target))?;
            let primary = reader.note(new_note)?.primary_resource_id.unwrap();
            assert_eq!(
                reader
                    .resource(&primary, Some(ResourceScope::note(new_note)))?
                    .info()
                    .hash,
                hash
            );
            assert_eq!(reader.annotations(new_note, false)?.len(), 1);
            assert_eq!(
                reader.pdf_coverage(new_note, &hash)?.unwrap().state(),
                IndexState::Complete
            );
            Ok(())
        })
        .unwrap()
        .wait()
        .unwrap();
}
