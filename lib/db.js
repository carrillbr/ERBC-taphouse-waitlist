const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS tables (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      seats INTEGER NOT NULL,
      sort INTEGER NOT NULL,
      party_id INTEGER,
      seated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS parties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      size INTEGER NOT NULL,
      phone TEXT,
      notes TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'staff',
      status TEXT NOT NULL DEFAULT 'waiting',
      quoted INTEGER,
      table_ids TEXT,
      created_at INTEGER NOT NULL,
      notified_at INTEGER,
      seated_at INTEGER,
      ended_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS parties_status ON parties(status);
    CREATE INDEX IF NOT EXISTS parties_phone ON parties(phone);

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      party_id INTEGER,
      direction TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  addColumn(db, 'parties', 'email', 'TEXT');
  addColumn(db, 'parties', 'news_opt_in', 'INTEGER NOT NULL DEFAULT 0');
  db.exec('CREATE INDEX IF NOT EXISTS parties_created ON parties(created_at)');
  return db;
}

// Add a column to an existing database if it isn't there yet.
function addColumn(db, table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

// TABLES="20:4,21:4,22:4,23:4,10:2,11:2" -> four 4-tops (20 to 23) and two 2-tops (10, 11), matching SpotOn.
function parseTables(spec) {
  return spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((item, i) => {
      let [label, seats] = item.split(':');
      label = label.trim();
      if (/^\d+$/.test(label)) label = `Table ${label}`;
      return { id: `t${i + 1}`, label, seats: Number(seats), sort: i };
    })
    .filter((t) => t.label && (t.seats === 2 || t.seats === 4));
}

// Keep the tables in the database in step with the TABLES setting,
// without disturbing anyone currently seated.
function syncTables(db, spec) {
  const wanted = parseTables(spec);
  const upsert = db.prepare(
    `INSERT INTO tables (id, label, seats, sort) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET label = excluded.label, seats = excluded.seats, sort = excluded.sort`
  );
  for (const t of wanted) upsert.run(t.id, t.label, t.seats, t.sort);
  const ids = wanted.map((t) => t.id);
  const stale = db.prepare('SELECT id FROM tables WHERE party_id IS NULL').all().filter((r) => !ids.includes(r.id));
  for (const r of stale) db.prepare('DELETE FROM tables WHERE id = ?').run(r.id);
}

function getSetting(db, key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(db, key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

module.exports = { openDb, parseTables, syncTables, getSetting, setSetting };
