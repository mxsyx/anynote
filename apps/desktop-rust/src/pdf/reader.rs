use crate::backend_client::{BackendClient, Response};
use anynote_core::{asset::*, backend::*};
use std::{
    io::{self, Read, Seek, SeekFrom},
    time::Duration,
};
use uuid::Uuid;

pub struct ResourceReader {
    client: BackendClient,
    token: Uuid,
    length: u64,
    position: u64,
}
fn request(client: &BackendClient, command: AssetCommand) -> Result<AssetReply, String> {
    match client
        .submit(Command::Asset(command), Duration::from_secs(15))
        .and_then(|h| h.receive_blocking())
        .map_err(|_| "无法读取 PDF 文件".to_owned())?
    {
        Response::Reply(Reply::Asset(reply)) => Ok(reply),
        _ => Err("无法读取 PDF 文件".to_owned()),
    }
}
impl ResourceReader {
    /// Blocking: use a background task, never a GPUI event/render callback.
    pub fn open(client: BackendClient, scope: AssetScope) -> Result<Self, String> {
        let token = Uuid::new_v4();
        let mut reader = Self {
            client,
            token,
            length: 0,
            position: 0,
        };
        let AssetReply::Opened { length, mime, .. } =
            request(&reader.client, AssetCommand::Open { scope, token })?
        else {
            return Err("无法读取 PDF 文件".to_owned());
        };
        if mime != "application/pdf" || length == 0 || length > 2 * 1024 * 1024 * 1024 {
            return Err("PDF 文件为空、超过 2 GiB 或格式不受支持".to_owned());
        }
        reader.length = length;
        Ok(reader)
    }
    pub fn length(&self) -> u64 {
        self.length
    }
}
impl ResourceReader {
    fn read_range_into(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let total = (self.length - self.position).min(buf.len() as u64) as usize;
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
        self.read_range_into(buf)
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
