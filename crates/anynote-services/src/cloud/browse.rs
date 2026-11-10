use super::*;
use anynote_storage::notebook::{Cancellation, ReadonlyNotebook};
use serde_json::{Value, json};

pub(super) fn project(
    session: &TransferSession,
    book: &ReadonlyNotebook,
    projection: &UploadProjection<'_>,
    cancel: &Cancellation,
) -> CloudResult<(Option<Value>, Option<Value>)> {
    let pending = projection.captures.unwrap_or_default();
    ensure(
        pending.len() <= 20 && pending.iter().all(|id| valid_uuid(id)),
        "CAPTURE_ACK_IDS",
    )?;
    // Browse is optional in v1; receipt evidence must survive a projection failure.
    let browse = if projection.browse {
        match project_browse(session, book, cancel) {
            Ok(value) => Some(value),
            Err(error) if error.cancelled() => return Err(error),
            Err(_) => None,
        }
    } else {
        None
    };
    let mut acks = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for id in pending {
        cancel.check()?;
        if seen.insert(id)
            && let Some(receipt) = book.capture_receipt(id)?
        {
            acks.push(receipt);
        }
    }
    acks.sort_by_key(|r| r.applied_seq);
    Ok((
        browse,
        if projection.captures.is_some() {
            Some(put(session, &serde_json::to_value(acks)?, 256 * 1024)?)
        } else {
            None
        },
    ))
}
fn project_browse(
    session: &TransferSession,
    book: &ReadonlyNotebook,
    cancel: &Cancellation,
) -> CloudResult<Value> {
    let nodes = book.browse_nodes()?;
    let mut objects = Vec::new();
    let mut at = 0;
    while at < nodes.len() {
        cancel.check()?;
        let parent = nodes[at]["parentId"].as_str().unwrap_or("root");
        let end = at
            + nodes[at..]
                .iter()
                .take_while(|n| n["parentId"] == nodes[at]["parentId"])
                .count();
        for (page, group) in nodes[at..end].chunks(100).enumerate() {
            let next = if group.len() == 100 {
                Some(page + 1)
            } else {
                None
            };
            let mut descriptor = put(session, &json!({"nodes":group,"next":next}), OBJECT_BYTES)?;
            descriptor["path"] = json!(format!("tree/{parent}/{page}"));
            objects.push(descriptor);
        }
        at = end;
    }
    for node in &nodes {
        cancel.check()?;
        if node["kind"] != "note" {
            continue;
        }
        let id = node["id"]
            .as_str()
            .ok_or_else(|| CloudError::new("BROWSE_NODE"))?;
        let mut descriptor = put(session, &book.browse_note(id)?, OBJECT_BYTES)?;
        descriptor["path"] = json!(format!("note/{id}"));
        objects.push(descriptor);
        ensure(objects.len() <= 30000, "BROWSE_BUDGET")?;
    }
    ensure(objects.len() <= 30000, "BROWSE_BUDGET")?;
    Ok(json!({"version":1,"objects":objects}))
}
fn put(session: &TransferSession, value: &Value, limit: u64) -> CloudResult<Value> {
    let bytes = stringify(value)?.into_bytes();
    ensure(bytes.len() as u64 <= limit, "BROWSE_OBJECT_BUDGET")?;
    let hash = digest(&bytes);
    session.write_bytes(&format!("objects/{hash}"), &bytes)?;
    Ok(json!({"hash":hash,"size":bytes.len()}))
}
