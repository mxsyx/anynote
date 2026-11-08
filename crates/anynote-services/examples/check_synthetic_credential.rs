use anynote_services::config_migration::credentials::{
    CredentialState, LegacyBackend, OsSecretStore, SecretStore, decrypt_legacy, migrate_credential,
};
use anynote_services::config_migration::preferences::ELECTRON_VERSION;
fn main() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::var("RM13_SYNTHETIC_ONLY").as_deref() != Ok("1") {
        return Err(
            "run only through rust-config-credential-smoke.mjs in a private D-Bus session".into(),
        );
    }
    let root =
        std::path::PathBuf::from(std::env::args().nth(1).ok_or("missing fixture directory")?);
    let encrypted = std::fs::read(root.join("secret.bin"))?;
    std::fs::create_dir(root.join("preserved"))?;
    let id = "11111111-1111-4111-8111-111111111111";
    let backend = LegacyBackend::LinuxSecretService {
        application: "anynote-rm13-fixture",
    };
    let report = migrate_credential(
        id,
        id,
        &encrypted,
        &root.join("preserved"),
        &OsSecretStore,
        |bytes| decrypt_legacy(bytes, &backend, ELECTRON_VERSION),
    )?;
    if report.state != CredentialState::MigratedAwaitingCapabilityCheck {
        return Err(format!("synthetic migration failed: {:?}", report.reason).into());
    }
    let stored = OsSecretStore.read(id)?.ok_or("missing roundtrip secret")?;
    if stored.as_slice() != br#"{"token":"rm13-synthetic-token"}"# {
        return Err("secret roundtrip mismatch".into());
    }
    std::fs::write(
        root.join("report.json"),
        serde_json::to_vec_pretty(&report)?,
    )?;
    println!("synthetic Electron -> native decrypt -> OS store -> verified read: passed");
    Ok(())
}
