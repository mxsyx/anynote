use anynote_services::migration::{Boundary, Error, Rehearsal};
use anynote_storage::notebook::{NotePatch, ReadonlyNotebook};
use std::{path::PathBuf, process::Command};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = std::env::args().collect::<Vec<_>>();
    let root = PathBuf::from(args.get(1).ok_or("root")?);
    let stop = args.get(2).map(String::as_str).unwrap_or("");
    let mut fault = |b: Boundary| {
        if format!("{b:?}") == stop {
            std::process::exit(86);
        }
        Ok(())
    };
    let mut session = Rehearsal::open_with(
        &root,
        &anynote_services::local_backup::NativeVolumes,
        &mut fault,
    )?;
    if matches!(
        session.phase(),
        anynote_services::migration::Phase::Preflight | anynote_services::migration::Phase::Copied
    ) {
        session.prepare(&mut fault)?;
    }
    if session.phase() == anynote_services::migration::Phase::Verified {
        session.activate(&mut fault)?;
    }
    if matches!(
        args.get(3).map(String::as_str),
        Some("write-and-rollback" | "rollback")
    ) && session.phase() != anynote_services::migration::Phase::Released
    {
        if args.get(3).map(String::as_str) == Some("write-and-rollback") {
            let id = args.get(4).ok_or("book id")?.clone();
            let note = args.get(5).ok_or("note id")?.clone();
            session
                .submit(&id, move |b| {
                    b.save_note(
                        &note,
                        1,
                        &NotePatch {
                            body: Some("RM14 latest body".into()),
                            ..Default::default()
                        },
                        &[],
                    )
                })?
                .wait()?;
        }
        session.rollback(
            &mut |paths| {
                for path in paths {
                    ReadonlyNotebook::open(path, None)?.integrity_check()?;
                }
                let status = Command::new("node")
                    .arg("scripts/rust-migration-legacy-read.mjs")
                    .args(paths)
                    .status()
                    .map_err(|_| Error("LEGACY_UNAVAILABLE"))?;
                if status.success() {
                    Ok(())
                } else {
                    Err(Error("LEGACY_UNREADABLE"))
                }
            },
            &mut fault,
        )?;
    }
    println!("{:?}", session.phase());
    Ok(())
}
