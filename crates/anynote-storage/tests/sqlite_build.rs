use rusqlite::Connection;

#[test]
fn bundled_sqlite_has_required_features_and_online_backup() -> rusqlite::Result<()> {
    let source = Connection::open_in_memory()?;
    source.execute_batch(
        "CREATE TABLE entries (id INTEGER PRIMARY KEY, title TEXT NOT NULL) STRICT;
        CREATE VIRTUAL TABLE search USING fts5(title, tokenize='trigram');
        INSERT INTO entries VALUES(1, '中文 AnyNote');
        INSERT INTO search VALUES('中文 AnyNote');",
    )?;
    let count: i64 = source.query_row(
        "SELECT count(*) FROM search WHERE search MATCH 'Any'",
        [],
        |row| row.get(0),
    )?;
    assert_eq!(count, 1);
    let json: (String, i64) = source.query_row(
        r#"SELECT json_extract('{"name":"中文😀"}', '$.name'), (SELECT count(*) FROM json_each('[1,2,3]'))"#,
        [], |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    assert_eq!(json, ("中文😀".into(), 3));
    let mut target = Connection::open_in_memory()?;
    rusqlite::backup::Backup::new(&source, &mut target)?.run_to_completion(
        8,
        std::time::Duration::ZERO,
        None,
    )?;
    let title: String = target.query_row("SELECT title FROM entries WHERE id = 1", [], |row| {
        row.get(0)
    })?;
    assert_eq!(title, "中文 AnyNote");
    Ok(())
}
