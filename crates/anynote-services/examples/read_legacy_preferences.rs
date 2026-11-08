use anynote_services::config_migration::preferences::{ELECTRON_VERSION, read_preferences};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() != 2 {
        return Err("usage: read_legacy_preferences <closed-copy/Local Storage/leveldb> <file://|http://127.0.0.1:5173>".into());
    }
    let report = read_preferences(std::path::Path::new(&args[0]), &args[1], ELECTRON_VERSION)?;
    // Counts only: preference values may contain private navigation history.
    println!(
        "complete={} migrated={} rejected={} ignored={}",
        report.is_complete(),
        report.preferences.values.len(),
        report.rejected_records,
        report.ignored_records
    );
    if !report.is_complete() {
        return Err("preferences require review; preserve the source copy".into());
    }
    Ok(())
}
