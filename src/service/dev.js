const sqlite3  = require('sqlite3');

const database = new sqlite3.Database("schema", err => {if (err) throw err});

module.exports = {
  db: database
}