//数据库的名字是"mydatebase.db"

const sqlite3 = require('sqlite3')

var database;
database = new sqlite3.Database("mydatebase.db", function(err) {
  if (err) throw err;
});

database.
