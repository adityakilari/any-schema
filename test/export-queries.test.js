// Runs the export queries against real database engines and feeds the output back into the parser.
// PostgreSQL: PGlite (Postgres compiled to WASM, a dev dependency). SQLite: node:sqlite (Node 22.13+).
// Each test is skipped when its engine is not available.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseText } from '../src/core/parse.js';
import { analyze } from '../src/core/analyze.js';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const toCsv = (cols, rows) => {
  const esc = (v) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
};

let PGlite = null;
try { ({ PGlite } = await import('@electric-sql/pglite')); } catch { /* optional */ }
let sqlite = null;
try { sqlite = await import('node:sqlite'); } catch { /* optional */ }

test('postgres.sql runs on PostgreSQL and round-trips', { skip: !PGlite && 'PGlite not installed' }, async () => {
  const db = new PGlite();
  await db.exec(read('samples/ecommerce-postgres.sql'));
  const res = await db.query(read('export-queries/postgres.sql'));
  assert.equal(res.rows.length, 79);
  const csv = toCsv(res.fields.map((f) => f.name), res.rows);
  const s = parseText(csv, 'schema.csv');
  const a = analyze(s);
  assert.equal(s.tables.length, 12);
  assert.ok(a.relationships.some((r) => r.from.name === 'orders' && r.to.name === 'customers' && r.source === 'declared'));
  assert.deepEqual(s.tables.find((t) => t.name === 'orders').columns.find((c) => c.name === 'status').enumValues.length, 6);
  await db.close();
});

test('information-schema.sql runs on PostgreSQL', { skip: !PGlite && 'PGlite not installed' }, async () => {
  const db = new PGlite();
  await db.exec(read('samples/ecommerce-postgres.sql'));
  const res = await db.query(read('export-queries/information-schema.sql'));
  const s = parseText(toCsv(res.fields.map((f) => f.name), res.rows), 'schema.csv');
  assert.equal(s.constraintsKnown, false);
  assert.ok(analyze(s).relationships.length >= 10, 'keys are inferred from names');
  await db.close();
});

test('sqlite.sql runs on SQLite and round-trips', { skip: !(sqlite && sqlite.DatabaseSync) && 'node:sqlite not available' }, () => {
  const db = new sqlite.DatabaseSync(':memory:');
  db.exec(`CREATE TABLE authors (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT UNIQUE);
           CREATE TABLE books (id INTEGER PRIMARY KEY, author_id INTEGER NOT NULL REFERENCES authors, title TEXT NOT NULL, price REAL);
           CREATE INDEX books_author ON books(author_id);
           CREATE VIEW v_books AS SELECT b.id, b.title, a.name FROM books b JOIN authors a ON a.id = b.author_id;`);
  const rows = db.prepare(read('export-queries/sqlite.sql')).all();
  const s = parseText(toCsv(Object.keys(rows[0]), rows), 'schema.csv');
  const books = s.tables.find((t) => t.name === 'books');
  assert.deepEqual(books.primaryKey, ['id']);
  assert.equal(books.foreignKeys[0].refTable, 'authors');
  assert.equal(s.tables.find((t) => t.name === 'authors').columns.find((c) => c.name === 'email').unique, true);
  assert.equal(s.tables.find((t) => t.name === 'v_books').kind, 'view');
  assert.ok(analyze(s).findings.some((f) => f.rule === 'money-as-float'));
});
