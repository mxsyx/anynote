use anynote_core::backend::*;
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};
use uuid::Uuid;

const MAX_RESOURCES: usize = 8;
const MAX_RESOURCE_BYTES: usize = 4 * 1024 * 1024;
const LEASE_DURATION: Duration = Duration::from_secs(60);
struct Lease {
    bytes: Vec<u8>,
    expires: Instant,
}
#[derive(Default)]
pub struct Resources {
    leases: HashMap<Uuid, Lease>,
}
impl Resources {
    pub fn grant(&mut self, bytes: Vec<u8>, now: Instant) -> ServiceResult<(Uuid, u64)> {
        self.leases.retain(|_, lease| lease.expires > now);
        if bytes.len() > MAX_RESOURCE_BYTES || self.leases.len() >= MAX_RESOURCES {
            return Err(ServiceError::new(ErrorCode::Busy));
        }
        let length = bytes.len() as u64;
        let token = Uuid::new_v4();
        self.leases.insert(
            token,
            Lease {
                bytes,
                expires: now + LEASE_DURATION,
            },
        );
        Ok((token, length))
    }
    pub fn read(
        &mut self,
        token: Uuid,
        offset: u64,
        length: u32,
        now: Instant,
    ) -> ServiceResult<(Vec<u8>, bool)> {
        self.leases.retain(|_, lease| lease.expires > now);
        let lease = self
            .leases
            .get(&token)
            .ok_or_else(|| ServiceError::new(ErrorCode::InvalidToken))?;
        if length == 0 || length as usize > MAX_CHUNK_BYTES || offset > lease.bytes.len() as u64 {
            return Err(ServiceError::new(ErrorCode::InvalidRequest));
        }
        let start = offset as usize;
        let end = (start + length as usize).min(lease.bytes.len());
        Ok((lease.bytes[start..end].to_vec(), end == lease.bytes.len()))
    }
    pub fn release(&mut self, token: Uuid) -> ServiceResult<()> {
        self.leases
            .remove(&token)
            .map(|_| ())
            .ok_or_else(|| ServiceError::new(ErrorCode::InvalidToken))
    }
}
