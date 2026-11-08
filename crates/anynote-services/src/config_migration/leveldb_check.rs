//! rusty-leveldb iterators suppress damaged block/log errors. Verify the physical
//! files before opening MemEnv so a partial scan cannot masquerade as migration.
use super::{MigrationError, Result};
const BAD: MigrationError = MigrationError::InvalidData;
const MAX_BLOCK: usize = 64 * 1024 * 1024;
fn u32le(b: &[u8]) -> Result<u32> {
    Ok(u32::from_le_bytes(
        b.get(..4).ok_or(BAD)?.try_into().map_err(|_| BAD)?,
    ))
}
fn crc(bytes: &[u8], stored: &[u8]) -> Result<()> {
    let actual = crc32c::crc32c(bytes)
        .rotate_right(15)
        .wrapping_add(0xa282ead8);
    if actual != u32le(stored)? {
        return Err(BAD);
    }
    Ok(())
}
fn varint(bytes: &[u8], pos: &mut usize) -> Result<usize> {
    let mut result = 0u64;
    for shift in (0..70).step_by(7) {
        let b = *bytes.get(*pos).ok_or(BAD)?;
        *pos += 1;
        if shift == 63 && b > 1 {
            return Err(BAD);
        }
        result |= u64::from(b & 127) << shift;
        if b < 128 {
            return result.try_into().map_err(|_| BAD);
        }
    }
    Err(BAD)
}
fn field<'a>(bytes: &'a [u8], pos: &mut usize) -> Result<&'a [u8]> {
    let size = varint(bytes, pos)?;
    let end = pos.checked_add(size).ok_or(BAD)?;
    let value = bytes.get(*pos..end).ok_or(BAD)?;
    *pos = end;
    Ok(value)
}
fn batch(bytes: &[u8]) -> Result<()> {
    if bytes.len() < 12 {
        return Err(BAD);
    }
    let count = u32le(&bytes[8..])?;
    let mut pos = 12;
    for _ in 0..count {
        let kind = *bytes.get(pos).ok_or(BAD)?;
        pos += 1;
        field(bytes, &mut pos)?;
        match kind {
            0 => (),
            1 => {
                field(bytes, &mut pos)?;
            }
            _ => return Err(BAD),
        }
    }
    if pos != bytes.len() {
        return Err(BAD);
    }
    Ok(())
}
fn log(bytes: &[u8], is_batch: bool) -> Result<()> {
    let mut pos = 0;
    let mut record = Vec::new();
    let mut fragmented = false;
    while pos < bytes.len() {
        let remaining = 32768 - pos % 32768;
        if remaining < 7 {
            let end = (pos + remaining).min(bytes.len());
            if bytes[pos..end].iter().any(|b| *b != 0) {
                return Err(BAD);
            }
            pos = end;
            continue;
        }
        let header = bytes.get(pos..pos + 7).ok_or(BAD)?;
        let size = usize::from(u16::from_le_bytes([header[4], header[5]]));
        if size + 7 > remaining {
            return Err(BAD);
        }
        let payload = bytes.get(pos + 7..pos + 7 + size).ok_or(BAD)?;
        let kind = header[6];
        if kind == 0 && size == 0 && header.iter().all(|b| *b == 0) {
            if bytes[pos..].iter().any(|b| *b != 0) {
                return Err(BAD);
            }
            break;
        }
        crc(&bytes[pos + 6..pos + 7 + size], header)?;
        match kind {
            1 if !fragmented => {
                if is_batch {
                    batch(payload)?;
                }
            }
            2 if !fragmented => {
                record.extend_from_slice(payload);
                fragmented = true;
            }
            3 | 4 if fragmented => {
                record.extend_from_slice(payload);
                if kind == 4 {
                    if is_batch {
                        batch(&record)?;
                    }
                    record.clear();
                    fragmented = false;
                }
            }
            _ => return Err(BAD),
        }
        pos += 7 + size;
    }
    if fragmented {
        return Err(BAD);
    }
    Ok(())
}
fn block(bytes: &[u8], handle: &[u8]) -> Result<Vec<u8>> {
    let mut pos = 0;
    let offset = varint(handle, &mut pos)?;
    let size = varint(handle, &mut pos)?;
    let end = offset.checked_add(size).ok_or(BAD)?;
    let stored = bytes
        .get(offset..end.checked_add(5).ok_or(BAD)?)
        .ok_or(BAD)?;
    crc(&stored[..size + 1], &stored[size + 1..])?;
    match stored[size] {
        0 => Ok(stored[..size].to_vec()),
        1 => {
            if snap::raw::decompress_len(&stored[..size]).map_err(|_| BAD)? > MAX_BLOCK {
                return Err(MigrationError::Budget);
            }
            snap::raw::Decoder::new()
                .decompress_vec(&stored[..size])
                .map_err(|_| BAD)
        }
        _ => Err(MigrationError::Unsupported),
    }
}
fn entries(bytes: &[u8]) -> Result<Vec<(Vec<u8>, Vec<u8>)>> {
    if bytes.len() < 8 {
        return Err(BAD);
    }
    let count = u32le(&bytes[bytes.len() - 4..])? as usize;
    let trailer = count
        .checked_mul(4)
        .and_then(|n| n.checked_add(4))
        .ok_or(BAD)?;
    let end = bytes.len().checked_sub(trailer).ok_or(BAD)?;
    if count == 0 {
        return Err(BAD);
    }
    let mut restarts = Vec::new();
    for raw in bytes[end..bytes.len() - 4].as_chunks::<4>().0 {
        let offset = u32le(raw)? as usize;
        if offset > end || restarts.last().is_some_and(|last| *last >= offset) {
            return Err(BAD);
        }
        restarts.push(offset);
    }
    let mut pos = 0;
    let mut previous = Vec::new();
    let mut rows = Vec::new();
    while pos < end {
        let start = pos;
        let shared = varint(&bytes[..end], &mut pos)?;
        let nonshared = varint(&bytes[..end], &mut pos)?;
        let size = varint(&bytes[..end], &mut pos)?;
        if shared > previous.len() || (restarts.binary_search(&start).is_ok() && shared != 0) {
            return Err(BAD);
        }
        previous.truncate(shared);
        let key_end = pos.checked_add(nonshared).ok_or(BAD)?;
        previous.extend_from_slice(
            bytes
                .get(pos..key_end)
                .filter(|_| key_end <= end)
                .ok_or(BAD)?,
        );
        pos = key_end;
        let value_end = pos.checked_add(size).ok_or(BAD)?;
        let value = bytes
            .get(pos..value_end)
            .filter(|_| value_end <= end)
            .ok_or(BAD)?;
        rows.push((previous.clone(), value.to_vec()));
        pos = value_end;
    }
    Ok(rows)
}
pub(super) fn validate(name: &str, bytes: &[u8]) -> Result<()> {
    if name.ends_with(".log") {
        return log(bytes, true);
    }
    if name.starts_with("MANIFEST-") {
        return log(bytes, false);
    }
    if name.ends_with(".ldb") || name.ends_with(".sst") {
        if bytes.len() < 48
            || bytes[bytes.len() - 8..] != [0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb]
        {
            return Err(BAD);
        }
        let footer = &bytes[bytes.len() - 48..bytes.len() - 8];
        let mut pos = 0;
        varint(footer, &mut pos)?;
        varint(footer, &mut pos)?;
        let meta = block(bytes, footer)?;
        for (_, handle) in entries(&meta)? {
            block(bytes, &handle)?;
        }
        let index = block(bytes, &footer[pos..])?;
        for (_, handle) in entries(&index)? {
            for (key, _) in entries(&block(bytes, &handle)?)? {
                if key.len() < 8 || key[key.len() - 8] > 1 {
                    return Err(BAD);
                }
            }
        }
    }
    Ok(())
}
