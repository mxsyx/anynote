use super::{MigrationError, Result, digest, read_bounded};
#[cfg(any(target_os = "linux", target_os = "macos", test))]
use aes::cipher::{BlockDecryptMut, KeyIvInit, block_padding::Pkcs7};
use serde::Serialize;
use std::{io::Write, path::Path};
use zeroize::Zeroizing;

const MAX_SECRET: usize = 128 * 1024;
pub const SECRET_SERVICE: &str = "app.anynote.credentials";

pub trait SecretStore {
    fn read(&self, id: &str) -> Result<Option<Zeroizing<Vec<u8>>>>;
    fn write(&self, id: &str, value: &[u8]) -> Result<()>;
}
/// Blocking OS calls: use the backend credential worker, never a UI/Tokio runtime thread.
pub struct OsSecretStore;
fn valid_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}
fn entry(id: &str) -> Result<keyring::Entry> {
    if !valid_id(id) {
        return Err(MigrationError::InvalidData);
    }
    keyring::Entry::new(SECRET_SERVICE, &format!("secret.{id}"))
        .map_err(|_| MigrationError::CredentialUnavailable)
}
impl SecretStore for OsSecretStore {
    fn read(&self, id: &str) -> Result<Option<Zeroizing<Vec<u8>>>> {
        match entry(id)?.get_secret() {
            Ok(value) => Ok(Some(Zeroizing::new(value))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(MigrationError::CredentialUnavailable),
        }
    }
    fn write(&self, id: &str, value: &[u8]) -> Result<()> {
        entry(id)?
            .set_secret(value)
            .map_err(|_| MigrationError::CredentialUnavailable)
    }
}

/// Explicit identity from the old installation. No key creation, unlocking or fallback password.
pub enum LegacyBackend<'a> {
    LinuxSecretService { application: &'a str },
    MacKeychain { service: &'a str, account: &'a str },
    Windows { local_state: &'a [u8] },
    Unsupported,
}

#[cfg(any(target_os = "linux", target_os = "macos", test))]
fn decrypt_cbc(
    ciphertext: &[u8],
    password: &[u8],
    iterations: u32,
    prefix: &[u8],
) -> Result<Zeroizing<Vec<u8>>> {
    let body = ciphertext
        .strip_prefix(prefix)
        .ok_or(MigrationError::Unsupported)?;
    if body.is_empty() || body.len() % 16 != 0 || body.len() > MAX_SECRET {
        return Err(MigrationError::InvalidData);
    }
    let mut key = Zeroizing::new([0u8; 16]);
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password, b"saltysalt", iterations, key.as_mut());
    let mut plaintext = Zeroizing::new(body.to_vec());
    let len = cbc::Decryptor::<aes::Aes128>::new_from_slices(key.as_ref(), &[b' '; 16])
        .map_err(|_| MigrationError::InvalidData)?
        .decrypt_padded_mut::<Pkcs7>(&mut plaintext)
        .map_err(|_| MigrationError::CredentialUnavailable)?
        .len();
    plaintext.truncate(len);
    Ok(plaintext)
}

pub fn decrypt_legacy(
    ciphertext: &[u8],
    backend: &LegacyBackend<'_>,
    electron_version: &str,
) -> Result<Zeroizing<Vec<u8>>> {
    if electron_version != super::preferences::ELECTRON_VERSION || ciphertext.len() > MAX_SECRET {
        return Err(MigrationError::Unsupported);
    }
    match backend {
        #[cfg(target_os = "linux")]
        LegacyBackend::LinuxSecretService { application } => {
            if !ciphertext.starts_with(b"v11") {
                return Err(MigrationError::Unsupported);
            }
            use secret_service::{EncryptionType, blocking::SecretService};
            let service = SecretService::connect(EncryptionType::Dh)
                .map_err(|_| MigrationError::CredentialUnavailable)?;
            let found = service
                .search_items(std::collections::HashMap::from([
                    ("application", *application),
                    ("xdg:schema", "chrome_libsecret_os_crypt_password_v2"),
                ]))
                .map_err(|_| MigrationError::CredentialUnavailable)?;
            if !found.locked.is_empty() || found.unlocked.len() != 1 {
                return Err(MigrationError::CredentialUnavailable);
            }
            let password = Zeroizing::new(
                found.unlocked[0]
                    .get_secret()
                    .map_err(|_| MigrationError::CredentialUnavailable)?,
            );
            if password.is_empty() {
                return Err(MigrationError::CredentialUnavailable);
            }
            decrypt_cbc(ciphertext, &password, 1, b"v11")
        }
        #[cfg(target_os = "macos")]
        LegacyBackend::MacKeychain { service, account } => {
            let password = Zeroizing::new(
                security_framework::passwords::get_generic_password(service, account)
                    .map_err(|_| MigrationError::CredentialUnavailable)?,
            );
            decrypt_cbc(ciphertext, &password, 1003, b"v10")
        }
        #[cfg(target_os = "windows")]
        LegacyBackend::Windows { local_state } => windows_decrypt(ciphertext, local_state),
        _ => Err(MigrationError::Unsupported),
    }
}

#[cfg(target_os = "windows")]
fn windows_decrypt(ciphertext: &[u8], local_state: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    use base64::Engine;
    if local_state.len() > 4 * 1024 * 1024
        || ciphertext.len() < 31
        || !ciphertext.starts_with(b"v10")
    {
        return Err(MigrationError::Unsupported);
    }
    let state: serde_json::Value =
        serde_json::from_slice(local_state).map_err(|_| MigrationError::InvalidData)?;
    let encoded = state["os_crypt"]["encrypted_key"]
        .as_str()
        .ok_or(MigrationError::InvalidData)?;
    let wrapped = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| MigrationError::InvalidData)?;
    let key = dpapi_unprotect(
        wrapped
            .strip_prefix(b"DPAPI")
            .ok_or(MigrationError::Unsupported)?,
    )?;
    decrypt_gcm(ciphertext, &key)
}

#[cfg(any(target_os = "windows", test))]
fn decrypt_gcm(ciphertext: &[u8], key: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    use aes_gcm::{Aes256Gcm, KeyInit, Nonce, aead::Aead};
    if ciphertext.len() < 31 || !ciphertext.starts_with(b"v10") {
        return Err(MigrationError::Unsupported);
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| MigrationError::InvalidData)?;
    cipher
        .decrypt(Nonce::from_slice(&ciphertext[3..15]), &ciphertext[15..])
        .map(Zeroizing::new)
        .map_err(|_| MigrationError::CredentialUnavailable)
}

#[cfg(target_os = "windows")]
#[allow(unsafe_code)]
fn dpapi_unprotect(encrypted: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    use windows::Win32::{
        Foundation::{HLOCAL, LocalFree},
        Security::Cryptography::{
            CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptUnprotectData,
        },
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: encrypted
            .len()
            .try_into()
            .map_err(|_| MigrationError::Budget)?,
        pbData: encrypted.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    // DPAPI owns output until LocalFree; copy and wipe it before releasing the allocation.
    unsafe {
        CryptUnprotectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|_| MigrationError::CredentialUnavailable)?;
        if output.pbData.is_null() {
            return Err(MigrationError::CredentialUnavailable);
        }
        let slice = std::slice::from_raw_parts_mut(output.pbData, output.cbData as usize);
        let result = Zeroizing::new(slice.to_vec());
        zeroize::Zeroize::zeroize(slice);
        let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
        Ok(result)
    }
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub enum CredentialState {
    MigratedAwaitingCapabilityCheck,
    ReauthenticationRequired,
}
#[derive(Debug, Serialize)]
#[non_exhaustive]
pub struct CredentialReport {
    pub connection_id: String,
    pub secret_id: String,
    pub ciphertext_sha256: String,
    pub state: CredentialState,
    pub tasks_paused: bool,
    pub reason: Option<String>,
}

/// Never replaces an existing different secret (it may have been reauthenticated).
/// Returned reports contain identities/status only; callers keep the original endpoint.
pub fn migrate_credential(
    connection_id: &str,
    secret_id: &str,
    ciphertext: &[u8],
    preserved_secrets: &Path,
    store: &impl SecretStore,
    decrypt: impl FnOnce(&[u8]) -> Result<Zeroizing<Vec<u8>>>,
) -> Result<CredentialReport> {
    if !valid_id(secret_id) || !valid_id(connection_id) || ciphertext.len() > MAX_SECRET {
        return Err(MigrationError::InvalidData);
    }
    if !std::fs::symlink_metadata(preserved_secrets)?
        .file_type()
        .is_dir()
    {
        return Err(MigrationError::InvalidData);
    }
    let path = preserved_secrets.join(format!("{secret_id}.bin"));
    if path.exists() {
        if read_bounded(&path, MAX_SECRET)? != ciphertext {
            return Err(MigrationError::Conflict);
        }
    } else {
        let mut file = tempfile::NamedTempFile::new_in(preserved_secrets)?;
        file.write_all(ciphertext)?;
        file.as_file().sync_all()?;
        file.persist_noclobber(&path)
            .map_err(|_| MigrationError::Io)?;
    }
    let result = (|| {
        let plaintext = decrypt(ciphertext)?;
        if plaintext.len() > MAX_SECRET {
            return Err(MigrationError::Budget);
        }
        #[derive(serde::Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Credentials<'a> {
            #[serde(borrow)]
            token: Option<std::borrow::Cow<'a, str>>,
        }
        let mut parsed: Credentials<'_> =
            serde_json::from_slice(&plaintext).map_err(|_| MigrationError::InvalidData)?;
        if let Some(std::borrow::Cow::Owned(token)) = parsed.token.as_mut() {
            zeroize::Zeroize::zeroize(token);
        }
        match store.read(secret_id)? {
            Some(existing) if *existing != *plaintext => return Err(MigrationError::Conflict),
            Some(_) => (),
            None => store.write(secret_id, &plaintext)?,
        }
        if store.read(secret_id)?.as_deref() != Some(&*plaintext) {
            return Err(MigrationError::VerificationFailed);
        }
        Ok(())
    })();
    Ok(CredentialReport {
        connection_id: connection_id.into(),
        secret_id: secret_id.into(),
        ciphertext_sha256: digest(ciphertext),
        state: if result.is_ok() {
            CredentialState::MigratedAwaitingCapabilityCheck
        } else {
            CredentialState::ReauthenticationRequired
        },
        tasks_paused: true,
        reason: result.err().map(|e| e.to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    #[derive(Default)]
    struct MemoryStore(RefCell<Option<Vec<u8>>>);
    impl SecretStore for MemoryStore {
        fn read(&self, _: &str) -> Result<Option<Zeroizing<Vec<u8>>>> {
            Ok(self.0.borrow().clone().map(Zeroizing::new))
        }
        fn write(&self, _: &str, value: &[u8]) -> Result<()> {
            *self.0.borrow_mut() = Some(value.into());
            Ok(())
        }
    }
    const ID: &str = "11111111-1111-4111-8111-111111111111";
    #[test]
    fn independently_generated_platform_vectors_and_failure() {
        fn hex(value: &serde_json::Value) -> Vec<u8> {
            value
                .as_str()
                .unwrap()
                .as_bytes()
                .as_chunks::<2>()
                .0
                .iter()
                .map(|b| u8::from_str_radix(std::str::from_utf8(b).unwrap(), 16).unwrap())
                .collect()
        }
        let vectors: Vec<serde_json::Value> = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/rust-migration/config/crypto-vectors.json"
        ))
        .unwrap();
        for vector in vectors {
            let mut encrypted = hex(&vector["ciphertext"]);
            let decrypt = |bytes: &[u8]| match vector["platform"].as_str().unwrap() {
                "windows" => decrypt_gcm(bytes, &hex(&vector["key"])),
                "macos" => decrypt_cbc(
                    bytes,
                    vector["password"].as_str().unwrap().as_bytes(),
                    1003,
                    b"v10",
                ),
                _ => decrypt_cbc(
                    bytes,
                    vector["password"].as_str().unwrap().as_bytes(),
                    1,
                    b"v11",
                ),
            };
            assert_eq!(digest(&decrypt(&encrypted).unwrap()), vector["sha256"]);
            encrypted.pop();
            assert!(decrypt(&encrypted).is_err());
        }
        assert!(decrypt_cbc(b"v10plaintext", b"peanuts", 1, b"v11").is_err());
    }
    #[test]
    fn preserves_ciphertext_and_pauses_without_plaintext_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let store = MemoryStore::default();
        let ciphertext = b"v11-synthetic-ciphertext";
        let report = migrate_credential(ID, ID, ciphertext, dir.path(), &store, |_| {
            Ok(Zeroizing::new(br#"{"token":"NEVER-ON-DISK"}"#.to_vec()))
        })
        .unwrap();
        assert_eq!(
            report.state,
            CredentialState::MigratedAwaitingCapabilityCheck
        );
        assert!(report.tasks_paused);
        assert!(
            !serde_json::to_string(&report)
                .unwrap()
                .contains("NEVER-ON-DISK")
        );
        assert_eq!(
            std::fs::read(dir.path().join(format!("{ID}.bin"))).unwrap(),
            ciphertext
        );
        let failed = migrate_credential(ID, ID, ciphertext, dir.path(), &store, |_| {
            Err(MigrationError::CredentialUnavailable)
        })
        .unwrap();
        assert_eq!(failed.state, CredentialState::ReauthenticationRequired);
        let conflict = migrate_credential(ID, ID, ciphertext, dir.path(), &store, |_| {
            Ok(Zeroizing::new(b"{}".to_vec()))
        })
        .unwrap();
        assert_eq!(conflict.reason.as_deref(), Some("Conflict"));
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}

#[cfg(test)]
mod failure_tests {
    use super::*;
    struct Locked;
    impl SecretStore for Locked {
        fn read(&self, _: &str) -> Result<Option<Zeroizing<Vec<u8>>>> {
            Err(MigrationError::CredentialUnavailable)
        }
        fn write(&self, _: &str, _: &[u8]) -> Result<()> {
            panic!("must not write when locked")
        }
    }
    #[test]
    fn unavailable_store_invalid_json_and_unknown_platform_require_reauthentication() {
        let dir = tempfile::tempdir().unwrap();
        let id = "11111111-1111-4111-8111-111111111111";
        for plaintext in [b"{}".as_slice(), b"not-json", b"null", b"{\"other\":1}"] {
            let report = migrate_credential(id, id, b"v11-synthetic", dir.path(), &Locked, |_| {
                Ok(Zeroizing::new(plaintext.to_vec()))
            })
            .unwrap();
            assert_eq!(report.state, CredentialState::ReauthenticationRequired);
            assert!(report.tasks_paused);
        }
        assert_eq!(
            decrypt_legacy(
                b"v99-synthetic",
                &LegacyBackend::Unsupported,
                super::super::preferences::ELECTRON_VERSION
            )
            .unwrap_err(),
            MigrationError::Unsupported
        );
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
}
