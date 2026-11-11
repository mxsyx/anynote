use super::PdfError;
use crate::backend_client::{BackendClient, Response};
use anynote_core::{asset::*, backend::*};
use std::{
    io::{self, Read, Seek, SeekFrom},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use uuid::Uuid;

pub struct ResourceReader {
    client: BackendClient,
    token: Uuid,
    hash: String,
    length: u64,
    position: u64,
    failed: Arc<AtomicBool>,
}
fn request(client: &BackendClient, command: AssetCommand) -> Result<AssetReply, PdfError> {
    match client
        .submit(Command::Asset(command), Duration::from_secs(15))
        .and_then(|h| h.receive_blocking())
        .map_err(|_| PdfError::Resource)?
    {
        Response::Reply(Reply::Asset(reply)) => Ok(reply),
        _ => Err(PdfError::Resource),
    }
}
impl ResourceReader {
    /// Blocking: call only on the PDF worker, never from a GPUI event/render callback.
    pub fn open(client: BackendClient, scope: AssetScope) -> Result<Self, PdfError> {
        let token = Uuid::new_v4();
        let mut reader = Self {
            client,
            token,
            hash: String::new(),
            length: 0,
            position: 0,
            failed: Arc::new(AtomicBool::new(false)),
        };
        let AssetReply::Opened { hash, length, mime } =
            request(&reader.client, AssetCommand::Open { scope, token })?
        else {
            return Err(PdfError::Resource);
        };
        if mime != "application/pdf" || length == 0 || length > 2 * 1024 * 1024 * 1024 {
            return Err(PdfError::Budget);
        }
        reader.hash = hash;
        reader.length = length;
        Ok(reader)
    }
    #[cfg(feature = "media")]
    pub(crate) fn failure_flag(&self) -> Arc<AtomicBool> {
        self.failed.clone()
    }
    pub fn hash(&self) -> &str {
        &self.hash
    }
    pub fn length(&self) -> u64 {
        self.length
    }
}
impl ResourceReader {
    fn read_range_into(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let total = (self.length - self.position).min(buf.len() as u64) as usize;
        // Pdfium 7350 can CHECK-fail on an interrupted custom-file read. Cancellation
        // belongs between native calls; an in-flight callback must finish its range.
        for part in buf[..total].chunks_mut(MAX_CHUNK_BYTES) {
            let reply = request(
                &self.client,
                AssetCommand::Read {
                    token: self.token,
                    offset: self.position,
                    length: part.len() as u32,
                },
            )
            .map_err(io::Error::other)?;
            let AssetReply::Chunk { bytes } = reply else {
                return Err(io::ErrorKind::InvalidData.into());
            };
            if bytes.len() != part.len() {
                return Err(io::ErrorKind::UnexpectedEof.into());
            }
            part.copy_from_slice(&bytes);
            self.position += part.len() as u64;
        }
        Ok(total)
    }
}
impl Read for ResourceReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let result = self.read_range_into(buf);
        if result.is_err() {
            self.failed.store(true, Ordering::Release);
        }
        result
    }
}
impl Seek for ResourceReader {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        let next = match from {
            SeekFrom::Start(n) => i128::from(n),
            SeekFrom::End(n) => i128::from(self.length) + i128::from(n),
            SeekFrom::Current(n) => i128::from(self.position) + i128::from(n),
        };
        if next < 0 || next > i128::from(self.length) {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        self.position = next as u64;
        Ok(self.position)
    }
}
impl Drop for ResourceReader {
    fn drop(&mut self) {
        let _ = self.client.submit(
            Command::Asset(AssetCommand::Close { token: self.token }),
            Duration::from_secs(10),
        );
    }
}
