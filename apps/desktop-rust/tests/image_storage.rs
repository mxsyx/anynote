use anynote_desktop::image::codec;
use anynote_services::{open_export::*, transfer::*};
use anynote_storage::notebook::*;
use std::{fs, io::Cursor, path::PathBuf, sync::atomic::AtomicBool};
use uuid::Uuid;

#[test]
fn copy_and_export_keep_image_history_and_rectangle_hashes() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tmp/rm21-storage")
        .join(Uuid::new_v4().to_string());
    fs::create_dir_all(&root).unwrap();
    let root = root.canonicalize().unwrap();
    let q = WriteQueue::open(&root, 2).unwrap();
    let mut out = Cursor::new(vec![]);
    image::DynamicImage::ImageRgba8(image::RgbaImage::from_fn(12, 8, |x, y| {
        image::Rgba([(x * 20) as u8, (y * 30) as u8, 99, 255])
    }))
    .write_to(&mut out, image::ImageFormat::Png)
    .unwrap();
    let original = out.into_inner();
    let rotated = codec::rotate(&original, 1, &AtomicBool::new(false)).unwrap();
    let (a, b) = (original.clone(), rotated.clone());
    let (request,old_hash,new_hash) = q.submit(move |s| {
        let source=s.create_notebook("source")?.id;
        let target=s.create_notebook("target")?.id;
        let book=s.notebook(&source)?;
        let resource=Uuid::new_v4().to_string();
        let note=book.create_node(&CreateNode::note("image",format!(":::anynote{{type=\"core.image\" version=\"1\"}}\n{{\"resourceId\":\"{resource}\",\"width\":320,\"future\":12345678901234567890}}\n:::")),
            &[ResourceWrite::bytes(resource.clone(),"original.png".into(),"image/png".into(),a)?])?;
        let head=note.head_revision_id.as_ref().unwrap();
        let old_hash=book.read().resources_at_revision(&note.node.id,head)?[0].asset_hash.clone();
        book.add_image_annotation(&note.node.id,head,&resource,&AnnotationInput {
            asset_hash:old_hash.clone(),page:1,selector:vec![Rectangle{x:0.1,y:0.2,width:0.3,height:0.4}],
            quote:String::new(),body:"old region".into(),color:"#ff0000".into(),
        })?;
        let updated=book.save_note(&note.node.id,1,&NotePatch::default(),&[
            ResourceWrite::bytes(resource,"rotated.png".into(),"image/png".into(),b)?])?;
        let new_hash=book.read().resources_at_revision(&note.node.id,updated.head_revision_id.as_ref().unwrap())?[0].asset_hash.clone();
        Ok((TransferRequest{notebook_id:source,target_notebook_id:target,id:note.node.id,
            target_parent_id:None,mode:TransferMode::Copy,operation_id:Uuid::new_v4().to_string(),expected_revision:2},old_hash,new_hash))
    }).unwrap().wait().unwrap();
    let copied = transfer_node(&q, request.clone()).unwrap().wait().unwrap();
    let cut = |mode| {
        let root = root.clone();
        let id = request.target_notebook_id.clone();
        let mut snapshot = q
            .submit(move |s| s.capture_snapshot(&id, &root, &Cancellation::default()))
            .unwrap()
            .wait()
            .unwrap();
        snapshot.prepare(mode, &Cancellation::default()).unwrap();
        snapshot
    };
    let source_cut = cut(SnapshotMode::Full);
    let book =
        ReadonlyNotebook::open(source_cut.path(), Some(&request.target_notebook_id)).unwrap();
    let note = book.note(&copied.id).unwrap();
    assert!(note.body.contains("12345678901234567890"));
    let pins = book.revision_resources().unwrap();
    assert_eq!(pins.len(), 2);
    for (hash, expected) in [(&old_hash, &original), (&new_hash, &rotated)] {
        let pin = pins.iter().find(|r| &r.asset_hash == hash).unwrap();
        let mut asset = book
            .resource(
                &pin.resource_id,
                Some(ResourceScope::note(&copied.id).with_revision(&pin.revision_id)),
            )
            .unwrap();
        assert_eq!(
            asset.read_range(hash, 0, expected.len()).unwrap(),
            *expected
        );
    }
    let annotations = book.annotations(&copied.id, false).unwrap();
    assert_eq!(annotations.len(), 1);
    assert_eq!(annotations[0].target_asset_hash, old_hash);
    assert_eq!(
        annotations[0].selector,
        serde_json::json!([{"x":0.1,"y":0.2,"width":0.3,"height":0.4}])
    );
    let full = cut(SnapshotMode::Full);
    let frozen = ReadonlyNotebook::open(full.path(), Some(&request.target_notebook_id)).unwrap();
    assert_eq!(frozen.revision_resources().unwrap().len(), 2);
    assert_eq!(
        frozen.annotations(&copied.id, false).unwrap()[0].target_asset_hash,
        old_hash
    );
    drop(frozen);
    drop(full);
    let output = root.join("markdown");
    export_markdown(
        &mut cut(SnapshotMode::Current),
        &output,
        OpenExportFormat::Directory,
        &Cancellation::default(),
    )
    .unwrap();
    let map: serde_json::Value =
        serde_json::from_slice(&fs::read(output.join("EXPORT-MAP.json")).unwrap()).unwrap();
    let paths = map["resources"].as_array().unwrap()[0]["resources"]
        .as_object()
        .unwrap();
    assert_eq!(paths.len(), 1);
    assert_eq!(
        fs::read(output.join(paths.values().next().unwrap().as_str().unwrap())).unwrap(),
        rotated
    );
    drop(book);
    drop(source_cut);
    drop(q);
    fs::remove_dir_all(root).unwrap();
}
