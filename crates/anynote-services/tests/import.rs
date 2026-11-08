use anynote_services::importer::*;
use anynote_storage::notebook::*;
use base64::Engine;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File},
    io::{Cursor, Write},
    path::PathBuf,
};
use zip::{ZipWriter, write::SimpleFileOptions};
fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}
fn temp() -> tempfile::TempDir {
    let dir = root().join("tmp/rm07");
    fs::create_dir_all(&dir).unwrap();
    tempfile::tempdir_in(dir.canonicalize().unwrap()).unwrap()
}
fn png() -> Vec<u8> {
    base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1cAAAAASUVORK5CYII=").unwrap()
}
fn fixture() -> (tempfile::TempDir, WriteQueue, ImportService, PreviewTarget) {
    let dir = temp();
    let queue = WriteQueue::open(dir.path(), 2).unwrap();
    let book = queue
        .submit(|c| c.create_notebook("Import"))
        .unwrap()
        .wait()
        .unwrap();
    let service = ImportService::new(dir.path()).unwrap();
    (
        dir,
        queue,
        service,
        PreviewTarget {
            notebook_id: book.id,
            parent_id: None,
        },
    )
}
fn page() -> ImportOptions {
    ImportOptions {
        page: true,
        ..Default::default()
    }
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn zip_bytes(entries: Vec<(String, Vec<u8>)>) -> Vec<u8> {
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in entries {
        zip.start_file(
            name,
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated),
        )
        .unwrap();
        zip.write_all(&bytes).unwrap();
    }
    zip.finish().unwrap().into_inner()
}
fn clip(body: &str, assets: Vec<(String, Vec<u8>)>, change: impl FnOnce(&mut Value)) -> Vec<u8> {
    let manifest_assets:Vec<_>=assets.iter().map(|(path,bytes)|json!({"path":path,"sha256":hash(bytes),"size":bytes.len(),"mime":"application/octet-stream","name":"attachment.bin"})).collect();
    let mut m = json!({"format":"anynote.capture","version":1,"captureId":"10000000-0000-4000-8000-000000000007","title":"capture","source":{"kind":"selection","url":"https://example.com/article","capturedAt":"2026-11-08T00:00:00.000Z"},"body":{"path":"content.md","sha256":hash(body.as_bytes()),"size":body.len()},"assets":manifest_assets,"missing":[],"complete":true});
    change(&mut m);
    let mut entries = vec![
        ("manifest.json".into(), serde_json::to_vec(&m).unwrap()),
        ("content.md".into(), body.as_bytes().to_vec()),
    ];
    entries.extend(assets);
    zip_bytes(entries)
}
fn file_input(dir: &std::path::Path, bytes: &[u8], name: &str) -> ImportInput {
    let path = dir.join(name);
    fs::write(&path, bytes).unwrap();
    ImportInput::File {
        file: File::open(path).unwrap(),
        name: name.into(),
    }
}
#[test]
fn html_readability_turndown_golden() {
    let fixtures: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/import/rm07-html.json"
    ))
    .unwrap();
    let mut failures = Vec::new();
    for f in fixtures.as_array().unwrap() {
        let r = convert_html(
            f["html"].as_str().unwrap(),
            "https://anynote.invalid/",
            f["mode"] == "page",
            &ImportBudget::default(),
            &CancellationToken::new(),
        )
        .unwrap();
        if r.body != f["body"] || r.title != f["title"] || r.fallback != f["fallback"] {
            failures.push(format!(
                "{}\nRust: {:?}\nTS: {:?}\ntitle {:?}/{:?}, fallback {:?}/{:?}",
                f["name"], r.body, f["body"], r.title, f["title"], r.fallback, f["fallback"]
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
#[test]
fn canonical_uses_js_number_format_and_utf16_key_order() {
    let fixtures: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/import/rm07-canonical.json"
    ))
    .unwrap();
    for f in fixtures.as_array().unwrap() {
        assert_eq!(canonical(&f["value"]).unwrap(), f["canonical"]);
    }
}
#[test]
fn html_budget_encoding_depth_and_cancel() {
    assert_eq!(decode_html(&[0xe9], "text/html; charset=windows-1252"), "é");
    assert!(
        convert_html(
            "<img><audio></audio>",
            "https://example.com",
            true,
            &ImportBudget {
                media_count: 1,
                ..Default::default()
            },
            &CancellationToken::new()
        )
        .is_err()
    );
    assert!(
        convert_html(
            &format!("{}x{}", "<div>".repeat(300), "</div>".repeat(300)),
            "https://example.com",
            true,
            &ImportBudget::default(),
            &CancellationToken::new()
        )
        .is_err()
    );
    let c = CancellationToken::new();
    c.cancel();
    assert!(
        convert_html(
            "<p>x</p>",
            "https://example.com",
            true,
            &ImportBudget::default(),
            &c
        )
        .err()
        .unwrap()
        .cancelled
    );
    assert!(
        !ImportBudget {
            concurrency: 5,
            ..Default::default()
        }
        .valid()
    );
}
#[tokio::test]
async fn preview_freezes_files_original_html_and_scopes_target() {
    let (dir, q, mut s, target) = fixture();
    fs::write(dir.path().join("pic.png"), png()).unwrap();
    let grant = s
        .authorize_directory(&target.notebook_id, dir.path())
        .unwrap();
    let html = "<title>Frozen</title><p>Original</p><img src='pic.png'>";
    let p = s
        .preview(
            target.clone(),
            ImportInput::Html(html.into()),
            ImportOptions {
                page: true,
                keep_original: true,
                directory_grant: Some(grant.clone()),
                ..Default::default()
            },
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(p.report.localized, 1);
    fs::write(dir.path().join("pic.png"), "changed").unwrap();
    let wrong = PreviewTarget {
        notebook_id: uuid::Uuid::new_v4().to_string(),
        parent_id: None,
    };
    assert!(s.get_preview(&wrong, &p.id).is_err());
    assert!(
        s.commit(&q, &wrong, &p.id, &CancellationToken::new())
            .is_err()
    );
    let n = s
        .commit(&q, &target, &p.id, &CancellationToken::new())
        .unwrap();
    assert_eq!(n.body, p.body);
    assert!(s.get_preview(&target, &p.id).is_err());
    let book = target.notebook_id.clone();
    q.submit(move |c| {
        let b = c.notebook(&book)?;
        let r = b.import_report(&n.node.id)?;
        let original = r.original_html.unwrap();
        let scope = Some(
            ResourceScope::note(&n.node.id).with_revision(n.head_revision_id.as_deref().unwrap()),
        );
        let mut a = b.read().resource(&original.resource_id, scope)?;
        assert_eq!(
            a.read_range(&a.info().hash.clone(), 0, a.info().size as usize)?,
            html.as_bytes()
        );
        Ok(())
    })
    .unwrap()
    .wait()
    .unwrap();
    s.revoke_directory(&target.notebook_id, &grant);
    assert!(
        s.preview(
            target,
            ImportInput::Html(html.into()),
            ImportOptions {
                directory_grant: Some(grant),
                ..page()
            },
            &CancellationToken::new()
        )
        .await
        .is_err()
    );
}
#[tokio::test]
async fn media_discovery_selection_decode_and_shared_budget() {
    let (dir, _q, mut s, target) = fixture();
    fs::write(dir.path().join("wide.png"), png()).unwrap();
    fs::write(dir.path().join("pic.png"), png()).unwrap();
    fs::write(dir.path().join("movie.mp4"), [1u8; 100]).unwrap();
    let grant = s
        .authorize_directory(&target.notebook_id, dir.path())
        .unwrap();
    let html = "<picture><source srcset='wide.png 2000w, giant.png 9000w'><img src='missing.png'></picture><img data-src='pic.png' src='missing.png'><video src='movie.mp4'></video><iframe src='https://www.youtube.com/embed/dQw4w9WgXcQ'></iframe><iframe src='https://evil.example/'></iframe>";
    let p = s
        .preview(
            target.clone(),
            ImportInput::Html(html.into()),
            ImportOptions {
                directory_grant: Some(grant),
                ..page()
            },
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(p.report.localized, 3);
    assert_eq!(p.report.media.len(), 5);
    assert!(p.body.contains("core.video"));
    assert!(p.body.contains("未本地化"));
    let inline = format!(
        "<p>test</p><img src='data:image/png;base64,{}'>",
        base64::engine::general_purpose::STANDARD.encode(png())
    );
    let p = s
        .preview(
            target.clone(),
            ImportInput::Html(inline.clone()),
            ImportOptions {
                keep_original: true,
                budget: ImportBudget {
                    total_bytes: inline.len() as u64 + 10,
                    ..Default::default()
                },
                ..page()
            },
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(p.report.failed, 1);
    assert_eq!(p.report.localized, 0);
    let p = s
        .preview(
            target.clone(),
            ImportInput::Html(inline.clone()),
            ImportOptions {
                budget: ImportBudget {
                    decode_bytes: 3,
                    ..Default::default()
                },
                ..page()
            },
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(p.report.failed, 1);
    let p = s
        .preview(
            target,
            ImportInput::Html(inline),
            ImportOptions {
                selected_sources: Some(HashSet::new()),
                ..page()
            },
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(p.report.localized, 0);
    assert_eq!(p.report.media[0].status, MediaStatus::Skipped);
}
#[tokio::test]
async fn retry_preserves_edits_skips_changed_lines_and_freezes_budget() {
    let (dir, q, mut s, target) = fixture();
    let p = s
        .preview(
            target.clone(),
            ImportInput::Html("<p>before</p><img src='one.png'><img src='two.png'>".into()),
            page(),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    let n = s
        .commit(&q, &target, &p.id, &CancellationToken::new())
        .unwrap();
    let changed = p.report.media[1].placeholder.clone().unwrap();
    let book = target.notebook_id.clone();
    let id = n.node.id.clone();
    let body = n.body.replace(&changed, &format!("{changed} user edit")) + "\n\nUser appended";
    q.submit(move |c| {
        c.notebook(&book)?.save_note(
            &id,
            1,
            &NotePatch {
                body: Some(body),
                ..Default::default()
            },
            &[],
        )
    })
    .unwrap()
    .wait()
    .unwrap();
    fs::write(dir.path().join("one.png"), png()).unwrap();
    fs::write(dir.path().join("two.png"), png()).unwrap();
    let grant = s
        .authorize_directory(&target.notebook_id, dir.path())
        .unwrap();
    let result = s
        .retry_media(
            &q,
            &target.notebook_id,
            &n.node.id,
            None,
            Some(&grant),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(result.applied, 1);
    assert_eq!(result.skipped, 1);
    assert!(result.note.body.contains("User appended"));
    assert!(result.note.body.contains("user edit"));
    assert_eq!(result.note.node.revision, 3);
    let c = CancellationToken::new();
    c.cancel();
    assert!(
        s.retry_media(&q, &target.notebook_id, &n.node.id, None, Some(&grant), &c)
            .await
            .err()
            .unwrap()
            .cancelled
    );
}
#[tokio::test]
async fn capture_frozen_legacy_corpus_receipt_and_reopen() {
    let (dir, q, mut s, target) = fixture();
    let path = root().join("tests/fixtures/rust-migration/corpus/capture.anyclip");
    let input = || ImportInput::File {
        file: File::open(&path).unwrap(),
        name: "capture.anyclip".into(),
    };
    assert!(
        s.preview(
            target.clone(),
            input(),
            ImportOptions {
                budget: ImportBudget {
                    media_bytes: 1,
                    ..Default::default()
                },
                ..page()
            },
            &CancellationToken::new()
        )
        .await
        .is_err()
    );
    let p = s
        .preview(target.clone(), input(), page(), &CancellationToken::new())
        .await
        .unwrap();
    assert!(p.body.contains("anynote-resource:"));
    let n = s
        .commit(&q, &target, &p.id, &CancellationToken::new())
        .unwrap();
    drop(q);
    let q = WriteQueue::open(dir.path(), 2).unwrap();
    let p = s
        .preview(target.clone(), input(), page(), &CancellationToken::new())
        .await
        .unwrap();
    let second = s
        .commit(&q, &target, &p.id, &CancellationToken::new())
        .unwrap();
    assert_eq!(n.node.id, second.node.id);
    assert_eq!(n.head_revision_id, second.head_revision_id);
    for name in ["unknown-version.anyclip", "body-hash.anyclip"] {
        let file = File::open(
            root()
                .join("tests/fixtures/rust-migration/corpus/invalid")
                .join(name),
        )
        .unwrap();
        assert!(
            s.preview(
                target.clone(),
                ImportInput::File {
                    file,
                    name: name.into()
                },
                page(),
                &CancellationToken::new()
            )
            .await
            .is_err()
        );
    }
}
#[tokio::test]
async fn capture_preserves_chatgpt_code_nested_references_and_rejects_malicious_packages() {
    let (dir, q, mut s, target) = fixture();
    let bytes = b"attachment".to_vec();
    let path = format!("assets/{}.bin", hash(&bytes));
    let card = include_str!("../../../tests/fixtures/import/rm07-chatgpt.md");
    let body = format!(
        "[![image]({path})](https://example.com)\n\n[ref]: <{path}> \"title\"\n\n[download][ref]\n\n`[literal](assets/missing.bin)`\n\n```md\n[example](file:///etc/passwd)\n```\n\n{card}"
    );
    let good = clip(&body, vec![(path.clone(), bytes.clone())], |_| {});
    let p = s
        .preview(
            target.clone(),
            file_input(dir.path(), &good, "ok.anyclip"),
            page(),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(p.body.contains(card));
    assert!(p.body.contains("`[literal](assets/missing.bin)`"));
    assert!(p.body.contains("[ref]: <anynote-resource:"));
    let n = s
        .commit(&q, &target, &p.id, &CancellationToken::new())
        .unwrap();
    let changed = clip("different", vec![], |_| {});
    let p = s
        .preview(
            target.clone(),
            file_input(dir.path(), &changed, "changed.anyclip"),
            page(),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(
        s.commit(&q, &target, &p.id, &CancellationToken::new())
            .is_err()
    );
    let cases = vec![
        clip("x", vec![], |m| m["version"] = json!(2)),
        clip("x", vec![], |m| m["extra"] = json!(true)),
        clip("x", vec![], |m| m["body"]["sha256"] = json!("0".repeat(64))),
        clip("[bad](../secret)", vec![], |_| {}),
        clip("<img src='https://example.com/a.png'>", vec![], |_| {}),
        clip("x", vec![], |m| {
            m["source"]["url"] = json!("https://example.com/?secret=1")
        }),
        clip("x", vec![], |m| m["complete"] = json!(false)),
        zip_bytes(vec![("../escape".into(), vec![1])]),
        clip(&format!("[a]({path})"), vec![(path, bytes)], |m| {
            m["assets"][0]["size"] = json!(999)
        }),
    ];
    for (i, bytes) in cases.iter().enumerate() {
        assert!(
            s.preview(
                target.clone(),
                file_input(dir.path(), bytes, &format!("bad{i}.anyclip")),
                page(),
                &CancellationToken::new()
            )
            .await
            .is_err(),
            "case {i}"
        );
    }
    let b = target.notebook_id;
    let got = q
        .submit(move |c| c.notebook(&b)?.read().note(&n.node.id))
        .unwrap()
        .wait()
        .unwrap();
    assert_eq!(got.body, n.body);
}
#[cfg(unix)]
#[test]
fn adjacent_capability_rejects_traversal_symlink_escape_fifo_and_replacement() {
    use std::os::unix::fs::symlink;
    let root = temp();
    let dir = root.path().join("authorized");
    fs::create_dir_all(dir.join("nested")).unwrap();
    fs::write(dir.join("nested/图.png"), png()).unwrap();
    fs::write(root.path().join("outside.png"), png()).unwrap();
    symlink(dir.join("nested/图.png"), dir.join("inside.png")).unwrap();
    symlink(root.path().join("outside.png"), dir.join("outside.png")).unwrap();
    assert!(
        std::process::Command::new("mkfifo")
            .arg(dir.join("pipe"))
            .status()
            .unwrap()
            .success()
    );
    let grant = DirectoryGrant::authorize(&dir).unwrap();
    assert!(grant.open("pipe").is_err());
    for path in [
        "nested/%E5%9B%BE.png",
        "inside.png",
        "https://anynote.invalid/inside.png",
    ] {
        assert!(grant.open(path).is_ok(), "{path}");
    }
    for path in [
        "../outside.png",
        "%2e%2e/outside.png",
        "outside.png",
        "/etc/passwd",
        "file:///etc/passwd",
        "https://example.com/a",
        "nested%5c../a",
        "nested/%00.png",
    ] {
        assert!(grant.open(path).is_err(), "{path}");
    }
    fs::rename(&dir, root.path().join("old")).unwrap();
    fs::create_dir(&dir).unwrap();
    assert!(grant.open("inside.png").is_err());
}

#[tokio::test]
async fn failed_import_transaction_rolls_back_note_report_receipt_and_revision() {
    let (_dir, q, mut s, target) = fixture();
    let p = s
        .preview(
            target.clone(),
            ImportInput::Markdown {
                title: "atomic".into(),
                body: "before".into(),
            },
            page(),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    let book = target.notebook_id.clone();
    q.submit(move |c| {
        let b = c.notebook(&book)?;
        let before = b.read().metadata().content_seq;
        let mut bad = p.report.clone();
        bad.original_html = Some(OriginalHtml {
            resource_id: uuid::Uuid::new_v4().to_string(),
            name: "missing.html".into(),
            size: 1,
        });
        let receipt = CaptureReceipt {
            capture_id: uuid::Uuid::new_v4().to_string(),
            digest: "a".repeat(64),
        };
        let req = CreateNode::note("atomic", "body");
        assert!(b.commit_import(&req, &[], &bad, Some(&receipt)).is_err());
        assert!(b.read().nodes()?.is_empty());
        assert_eq!(b.read().metadata().content_seq, before);
        let n = b.commit_import(&req, &[], &p.report, Some(&receipt))?;
        assert_eq!(b.read().nodes()?.len(), 1);
        let again = b.commit_import(&req, &[], &p.report, Some(&receipt))?;
        assert_eq!(again.node.id, n.node.id);
        assert_eq!(b.read().metadata().content_seq, before + 1);
        Ok(())
    })
    .unwrap()
    .wait()
    .unwrap();
}

#[tokio::test]
async fn file_markdown_pdf_cancel_and_discard() {
    let (dir, q, mut s, target) = fixture();
    let body = "# Markdown\n\n`code`\n\n未知内容 😀";
    let p = s
        .preview(
            target.clone(),
            file_input(dir.path(), body.as_bytes(), "note.md"),
            page(),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(p.body, body);
    s.discard(&target, &p.id).unwrap();
    assert!(s.get_preview(&target, &p.id).is_err());
    let p = s
        .preview(
            target.clone(),
            file_input(dir.path(), b"%PDF-1.7\nfixture", "paper.pdf"),
            page(),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    let n = s
        .commit(&q, &target, &p.id, &CancellationToken::new())
        .unwrap();
    assert_eq!(n.node.note_type, Some(NoteType::Pdf));
    assert!(n.primary_resource_id.is_some());
    let p = s
        .preview(
            target.clone(),
            ImportInput::Markdown {
                title: "cancel".into(),
                body: "not written".into(),
            },
            page(),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    let token = CancellationToken::new();
    token.cancel();
    assert!(s.commit(&q, &target, &p.id, &token).is_err());
    let b = target.notebook_id;
    assert_eq!(
        q.submit(move |c| c.notebook(&b)?.read().nodes())
            .unwrap()
            .wait()
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn retry_remaining_budget_and_concurrent_report_change_are_enforced() {
    let (dir, q, mut s, target) = fixture();
    let p = s
        .preview(
            target.clone(),
            ImportInput::Html("<img src='pic.png'>".into()),
            ImportOptions {
                budget: ImportBudget {
                    total_bytes: 10,
                    ..Default::default()
                },
                ..page()
            },
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    let n = s
        .commit(&q, &target, &p.id, &CancellationToken::new())
        .unwrap();
    fs::write(dir.path().join("pic.png"), png()).unwrap();
    let grant = s
        .authorize_directory(&target.notebook_id, dir.path())
        .unwrap();
    let r = s
        .retry_media(
            &q,
            &target.notebook_id,
            &n.node.id,
            None,
            Some(&grant),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(r.applied, 0);
    assert_eq!(r.report.failed, 1);
    assert!(r.report.media[0].error.as_deref().unwrap().contains("预算"));
    let b = target.notebook_id;
    let id = n.node.id;
    q.submit(move |c| {
        let book = c.notebook(&b)?;
        let old = book.import_report(&id)?;
        let updated = book.retry_import_media(
            &id,
            &old,
            vec![ImportRetryOutcome {
                index: 0,
                resource: None,
                size: 0,
                error: Some("other attempt".into()),
            }],
        )?;
        assert!(book.retry_import_media(&id, &old, vec![]).is_err());
        assert_eq!(book.import_report(&id)?, updated.report);
        Ok(())
    })
    .unwrap()
    .wait()
    .unwrap();
}

#[tokio::test]
async fn capture_preflight_rejects_duplicate_entries_and_declared_excess() {
    let (dir, _q, mut s, target) = fixture();
    let good = clip("valid", vec![], |_| {});
    let end = good.len() - 22;
    let central = u32::from_le_bytes(good[end + 16..end + 20].try_into().unwrap()) as usize;
    let name = u16::from_le_bytes(good[central + 28..central + 30].try_into().unwrap()) as usize;
    let extra = u16::from_le_bytes(good[central + 30..central + 32].try_into().unwrap()) as usize;
    let comment = u16::from_le_bytes(good[central + 32..central + 34].try_into().unwrap()) as usize;
    let entry = &good[central..central + 46 + name + extra + comment];
    let mut duplicated = good[..end].to_vec();
    duplicated.extend_from_slice(entry);
    let mut footer = good[end..].to_vec();
    footer[8..10].copy_from_slice(&3u16.to_le_bytes());
    footer[10..12].copy_from_slice(&3u16.to_le_bytes());
    let size = u32::from_le_bytes(footer[12..16].try_into().unwrap()) + entry.len() as u32;
    footer[12..16].copy_from_slice(&size.to_le_bytes());
    duplicated.extend_from_slice(&footer);
    let mut excessive = good.clone();
    excessive[end + 8..end + 10].copy_from_slice(&203u16.to_le_bytes());
    excessive[end + 10..end + 12].copy_from_slice(&203u16.to_le_bytes());
    let mut symlink = good.clone();
    symlink[central + 38..central + 42].copy_from_slice(&(0o120777u32 << 16).to_le_bytes());
    let mut encrypted = good.clone();
    encrypted[central + 8..central + 10].copy_from_slice(&1u16.to_le_bytes());
    for (i, bytes) in [duplicated, excessive, symlink, encrypted]
        .iter()
        .enumerate()
    {
        assert!(
            s.preview(
                target.clone(),
                file_input(dir.path(), bytes, &format!("preflight{i}.anyclip")),
                page(),
                &CancellationToken::new()
            )
            .await
            .is_err()
        );
    }
}

#[tokio::test]
async fn retry_two_media_in_one_table_row_preserves_other_cells() {
    let (dir, q, mut s, target) = fixture();
    let p=s.preview(target.clone(),ImportInput::Html("<table><tr><th>Pictures</th><th>Text</th></tr><tr><td><img src='a.png'><img src='b.png'></td><td>preserve</td></tr></table>".into()),page(),&CancellationToken::new()).await.unwrap();
    let n = s
        .commit(&q, &target, &p.id, &CancellationToken::new())
        .unwrap();
    fs::write(dir.path().join("a.png"), png()).unwrap();
    fs::write(dir.path().join("b.png"), png()).unwrap();
    let grant = s
        .authorize_directory(&target.notebook_id, dir.path())
        .unwrap();
    let result = s
        .retry_media(
            &q,
            &target.notebook_id,
            &n.node.id,
            None,
            Some(&grant),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(result.applied, 2);
    assert!(result.note.body.contains("| preserve |"));
    assert_eq!(result.note.body.matches("anynote-resource:").count(), 2);
}

#[tokio::test]
async fn sequential_table_retry_refreshes_context_and_code_wrapping_is_preserved() {
    let (dir, q, mut s, target) = fixture();
    let p = s
        .preview(
            target.clone(),
            ImportInput::Html(
                "<table><tr><td><img src='a.png'><img src='b.png'></td></tr></table>".into(),
            ),
            page(),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    let n = s
        .commit(&q, &target, &p.id, &CancellationToken::new())
        .unwrap();
    for name in ["a.png", "b.png"] {
        fs::write(dir.path().join(name), png()).unwrap();
    }
    let grant = s
        .authorize_directory(&target.notebook_id, dir.path())
        .unwrap();
    for name in ["a.png", "b.png"] {
        let sources = HashSet::from([name.to_string()]);
        let result = s
            .retry_media(
                &q,
                &target.notebook_id,
                &n.node.id,
                Some(&sources),
                Some(&grant),
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(result.applied, 1);
    }
    let p = s
        .preview(
            target.clone(),
            ImportInput::Html("<img src='a.png'>".into()),
            page(),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    let n = s
        .commit(&q, &target, &p.id, &CancellationToken::new())
        .unwrap();
    let book = target.notebook_id.clone();
    let id = n.node.id.clone();
    q.submit(move |c| {
        c.notebook(&book)?.save_note(
            &id,
            1,
            &NotePatch {
                body: Some(format!("```text\n{}\n```", n.body)),
                ..Default::default()
            },
            &[],
        )
    })
    .unwrap()
    .wait()
    .unwrap();
    let result = s
        .retry_media(
            &q,
            &target.notebook_id,
            &n.node.id,
            None,
            Some(&grant),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(result.applied, 0);
    assert_eq!(result.skipped, 1);
    assert!(result.note.body.contains("```text"));
}
