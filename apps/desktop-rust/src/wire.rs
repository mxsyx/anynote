use anynote_core::backend::*;
use serde::{Serialize, de::DeserializeOwned};
use std::io::{Read, Write};

const MAX_STREAM_HEADER: usize = 512;
#[derive(Debug)]
pub enum Frame {
    Control(Vec<u8>),
    Binary(StreamHeader, Vec<u8>),
}
fn invalid() -> ServiceError {
    ServiceError::new(ErrorCode::InvalidRequest)
}
fn disconnected(_: std::io::Error) -> ServiceError {
    ServiceError::new(ErrorCode::Disconnected)
}
impl Frame {
    pub fn control(value: &impl Serialize) -> ServiceResult<Self> {
        let bytes = serde_json::to_vec(value).map_err(|_| invalid())?;
        if bytes.len() > MAX_CONTROL_BYTES {
            return Err(ServiceError::new(ErrorCode::FrameTooLarge));
        }
        Ok(Self::Control(bytes))
    }
    pub fn decode<T: DeserializeOwned>(&self) -> ServiceResult<T> {
        match self {
            Self::Control(bytes) => serde_json::from_slice(bytes).map_err(|_| invalid()),
            _ => Err(invalid()),
        }
    }
}

// Each lane has its own bound, checked before allocating the body.
pub fn read_frame(reader: &mut impl Read) -> ServiceResult<Option<Frame>> {
    let mut kind = [0];
    match reader.read(&mut kind) {
        Ok(0) => return Ok(None),
        Ok(_) => (),
        Err(error) => return Err(disconnected(error)),
    }
    let mut size = [0; 4];
    reader.read_exact(&mut size).map_err(disconnected)?;
    let length = u32::from_be_bytes(size) as usize;
    let limit = match kind[0] {
        1 => MAX_CONTROL_BYTES,
        2 => MAX_CHUNK_BYTES + MAX_STREAM_HEADER + 4,
        _ => return Err(invalid()),
    };
    if length > limit {
        return Err(ServiceError::new(ErrorCode::FrameTooLarge));
    }
    let mut bytes = vec![0; length];
    reader.read_exact(&mut bytes).map_err(disconnected)?;
    if kind[0] == 1 {
        return Ok(Some(Frame::Control(bytes)));
    }
    if bytes.len() < 4 {
        return Err(invalid());
    }
    let header_len = u32::from_be_bytes(bytes[..4].try_into().map_err(|_| invalid())?) as usize;
    if header_len > MAX_STREAM_HEADER
        || header_len + 4 > bytes.len()
        || bytes.len() - header_len - 4 > MAX_CHUNK_BYTES
    {
        return Err(invalid());
    }
    let header = serde_json::from_slice(&bytes[4..4 + header_len]).map_err(|_| invalid())?;
    Ok(Some(Frame::Binary(header, bytes.split_off(4 + header_len))))
}
pub fn write_frame(writer: &mut impl Write, frame: &Frame) -> ServiceResult<()> {
    match frame {
        Frame::Control(bytes) => {
            if bytes.len() > MAX_CONTROL_BYTES {
                return Err(ServiceError::new(ErrorCode::FrameTooLarge));
            }
            writer.write_all(&[1]).map_err(disconnected)?;
            writer
                .write_all(&(bytes.len() as u32).to_be_bytes())
                .map_err(disconnected)?;
            writer.write_all(bytes).map_err(disconnected)?;
        }
        Frame::Binary(header, bytes) => {
            let header = serde_json::to_vec(header).map_err(|_| invalid())?;
            if header.len() > MAX_STREAM_HEADER || bytes.len() > MAX_CHUNK_BYTES {
                return Err(ServiceError::new(ErrorCode::FrameTooLarge));
            }
            writer.write_all(&[2]).map_err(disconnected)?;
            writer
                .write_all(&((4 + header.len() + bytes.len()) as u32).to_be_bytes())
                .map_err(disconnected)?;
            writer
                .write_all(&(header.len() as u32).to_be_bytes())
                .map_err(disconnected)?;
            writer.write_all(&header).map_err(disconnected)?;
            writer.write_all(bytes).map_err(disconnected)?;
        }
    }
    writer.flush().map_err(disconnected)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use uuid::Uuid;

    #[test]
    fn binary_blocks_roundtrip_and_lengths_are_checked_before_body_reads() {
        let bytes: Vec<_> = (0..MAX_CHUNK_BYTES).map(|ix| (ix % 256) as u8).collect();
        let header = StreamHeader::new(Uuid::new_v4(), 1, Uuid::new_v4(), 77, false);
        let mut encoded = vec![];
        write_frame(&mut encoded, &Frame::Binary(header.clone(), bytes.clone())).unwrap();
        let Some(Frame::Binary(decoded, output)) = read_frame(&mut Cursor::new(encoded)).unwrap()
        else {
            panic!("expected binary")
        };
        assert_eq!(decoded, header);
        assert_eq!(output, bytes);
        for (kind, size) in [
            (1, MAX_CONTROL_BYTES + 1),
            (2, MAX_CHUNK_BYTES + MAX_STREAM_HEADER + 5),
        ] {
            let mut prefix = vec![kind];
            prefix.extend((size as u32).to_be_bytes());
            assert_eq!(
                read_frame(&mut Cursor::new(prefix)).unwrap_err().code(),
                ErrorCode::FrameTooLarge
            );
        }
        assert!(
            write_frame(
                &mut vec![],
                &Frame::Binary(header, vec![0; MAX_CHUNK_BYTES + 1])
            )
            .is_err()
        );
    }
    #[test]
    fn commands_reject_untyped_and_extra_payloads() {
        for command in [
            serde_json::json!({"op":"execute_plugin"}),
            serde_json::json!({"op":"start_health_check", "input":{"delay_ms":1,"token":"secret"}}),
            serde_json::json!({"op":"start_health_check", "input":{"delay_ms":-1}}),
            serde_json::json!({"op":"ping", "unexpected":"secret"}),
        ] {
            let value = serde_json::json!({"version":1,"epoch":Uuid::new_v4(),"request_id":1,"command":command});
            assert!(Frame::control(&value).unwrap().decode::<Request>().is_err());
        }
    }
}
