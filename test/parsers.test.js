import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseText, detectFormat } from '../src/core/parse.js';
import { detectSqlDialect } from '../src/core/parsers/sql.js';

const sample = (f) => fs.readFileSync(new URL(`../samples/${f}`, import.meta.url), 'utf8');
const load = (f) => parseText(sample(f), f);
const table = (s, n) => s.tables.find((t) => t.name === n);
const col = (t, n) => t.columns.find((c) => c.name === n);
const fk = (t, c) => t.foreignKeys.find((f) => f.columns.includes(c));

test('detects formats', () => {
  assert.equal(detectFormat('CREATE TABLE a (id int);', 'x'), 'sql');
  assert.equal(detectFormat('model User {\n id Int @id\n}', 'x'), 'prisma');
  assert.equal(detectFormat('{"type":"object"}', 'x'), 'json');
  assert.equal(detectFormat('table_name,column_name,data_type\na,b,int', 'x'), 'csv');
  assert.equal(detectFormat('anything', 'schema.prisma'), 'prisma');
});

test('detects SQL dialects', () => {
  assert.equal(detectSqlDialect(sample('ecommerce-postgres.sql')), 'postgres');
  assert.equal(detectSqlDialect(sample('blog-mysql.sql')), 'mysql');
  assert.equal(detectSqlDialect(sample('crm-sqlserver.sql')), 'sqlserver');
  assert.equal(detectSqlDialect(sample('hr-oracle.sql')), 'oracle');
  assert.equal(detectSqlDialect('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT);'), 'sqlite');
  assert.equal(detectSqlDialect('create or replace TABLE T (ID NUMBER(38,0) NOT NULL autoincrement start 1 increment 1 noorder, V VARIANT);'), 'snowflake');
});

test('PostgreSQL pg_dump: tables, enums, ALTER TABLE keys, comments, views', () => {
  const s = load('ecommerce-postgres.sql');
  assert.equal(s.tables.length, 12);
  const orders = table(s, 'orders');
  assert.deepEqual(orders.primaryKey, ['id']);
  assert.equal(col(orders, 'id').autoIncrement, true);
  assert.deepEqual(col(orders, 'status').enumValues, ['pending', 'paid', 'shipped', 'delivered', 'cancelled', 'refunded']);
  assert.equal(fk(orders, 'customer_id').refTable, 'customers');
  assert.equal(orders.comment, 'A checkout by a customer. Totals are snapshotted at purchase time.');
  assert.equal(col(table(s, 'products'), 'price').comment, 'Unit price in the product currency.');
  assert.equal(col(table(s, 'customers'), 'created_at').rawType, 'timestamp with time zone');
  assert.deepEqual(table(s, 'product_tags').primaryKey, ['product_id', 'tag_id']);
  assert.equal(fk(table(s, 'order_items'), 'product_id').onDelete, 'RESTRICT');
  assert.equal(col(table(s, 'customers'), 'email').unique, true);
  const view = table(s, 'customer_order_totals');
  assert.equal(view.kind, 'view');
  assert.deepEqual(view.columns.map((c) => c.name), ['customer_id', 'email', 'order_count', 'lifetime_value']);
  assert.deepEqual(view.meta.sources.sort(), ['customers', 'orders']);
});

test('MySQL dump: backticks, inline keys, enum(), COMMENT, AUTO_INCREMENT', () => {
  const s = load('blog-mysql.sql');
  const users = table(s, 'users');
  assert.equal(users.comment, 'Registered site users');
  assert.deepEqual(col(users, 'role').enumValues, ['reader', 'author', 'editor', 'admin']);
  assert.equal(col(users, 'id').autoIncrement, true);
  assert.equal(col(users, 'email').unique, true);
  const posts = table(s, 'posts');
  assert.equal(col(posts, 'author_id').comment, 'The user who wrote the post');
  assert.equal(fk(posts, 'author_id').onDelete, 'CASCADE');
  assert.ok(posts.indexes.some((i) => i.columns[0] === 'author_id'));
  assert.equal(col(table(s, 'comments'), 'is_approved').category, 'boolean');
});

test('SQL Server: brackets, GO, IDENTITY, computed columns, ALTER ADD DEFAULT, extended properties', () => {
  const s = load('crm-sqlserver.sql');
  assert.equal(s.tables.length, 5);
  const acc = table(s, 'Accounts');
  assert.equal(acc.schema, 'dbo');
  assert.equal(acc.comment, 'Companies we sell to or partner with.');
  assert.equal(col(acc, 'AccountID').autoIncrement, true);
  assert.equal(col(acc, 'CreatedDate').default, 'sysutcdatetime()');
  const opp = table(s, 'Opportunities');
  assert.match(col(opp, 'ExpectedRevenue').computed, /Amount/);
  assert.match(col(opp, 'Stage').comment, /Prospecting/);
  assert.equal(fk(opp, 'AccountID').onDelete, 'CASCADE');
  assert.ok(!s.tables.some((t) => t.columns.some((c) => c.name.toUpperCase() === 'DEFAULT')));
});

test('Oracle GET_DDL: quoted names, NUMBER, CHECK with comparisons, USING INDEX clauses', () => {
  const s = load('hr-oracle.sql');
  assert.equal(s.tables.length, 7);
  const emp = table(s, 'EMPLOYEES');
  assert.equal(emp.schema, 'HR');
  assert.deepEqual(emp.primaryKey, ['EMPLOYEE_ID']);
  assert.equal(col(emp, 'EMPLOYEE_ID').category, 'integer');
  assert.equal(col(emp, 'SALARY').category, 'decimal');
  assert.equal(fk(emp, 'MANAGER_ID').refTable, 'EMPLOYEES');
  assert.equal(emp.columns.length, 11);
  assert.deepEqual(table(s, 'JOB_HISTORY').primaryKey, ['EMPLOYEE_ID', 'START_DATE']);
  assert.match(col(emp, 'COMMISSION_PCT').comment, /Commission percentage/);
});

test('BigQuery / Snowflake style DDL', () => {
  const s = parseText('CREATE TABLE `p.ds.events` (id STRING NOT NULL, tags ARRAY<STRING>, payload STRUCT<a INT64, b STRING>, at TIMESTAMP OPTIONS(description="When it happened")) OPTIONS(description="Event stream");', 'bq.sql');
  const t = s.tables[0];
  assert.equal(t.name, 'events');
  assert.equal(t.comment, 'Event stream');
  assert.deepEqual(t.columns.map((c) => c.name), ['id', 'tags', 'payload', 'at']);
  assert.equal(t.columns[3].comment, 'When it happened');
  const sf = parseText(`create or replace TABLE CUSTOMERS (\n ID NUMBER(38,0) NOT NULL autoincrement start 1 increment 1 noorder,\n NAME VARCHAR(100) COMMENT 'Full name',\n primary key (ID)\n);\ncreate or replace TABLE ORDERS (ID NUMBER(38,0), CUSTOMER_ID NUMBER(38,0), constraint FK_C foreign key (CUSTOMER_ID) references DB.PUBLIC.CUSTOMERS(ID));`, 'sf.sql');
  assert.equal(table(sf, 'CUSTOMERS').columns[0].autoIncrement, true);
  assert.equal(table(sf, 'CUSTOMERS').columns[1].comment, 'Full name');
  assert.equal(fk(table(sf, 'ORDERS'), 'CUSTOMER_ID').refTable, 'CUSTOMERS');
});

test('Prisma: relations, @@id, @map, enums, native types', () => {
  const s = load('saas.prisma');
  assert.equal(s.source.dialect, 'postgres');
  const m = table(s, 'Membership');
  assert.deepEqual(m.primaryKey, ['organizationId', 'userId']);
  assert.equal(m.foreignKeys.length, 2);
  assert.equal(fk(m, 'userId').onDelete, 'Cascade');
  const user = table(s, 'User');
  assert.equal(col(user, 'id').category, 'uuid');
  assert.equal(col(user, 'passwordHash').meta.dbName, 'password_hash');
  assert.equal(user.meta.dbName, 'users');
  assert.ok(!col(user, 'memberships'), 'back-relation fields are not columns');
  assert.deepEqual(col(table(s, 'Task'), 'status').enumValues, ['TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE']);
  assert.equal(table(s, 'Organization').comment, 'A customer company. Every other record belongs to exactly one organization.');
});

test('JSON Schema: $defs, $ref embedding, nested objects, required', () => {
  const s = load('library.schema.json');
  const book = table(s, 'Book');
  assert.equal(fk(book, 'publisher').embedded, true);
  assert.equal(col(book, 'title').nullable, false);
  assert.equal(col(book, 'publishedYear').nullable, true);
  assert.ok(col(table(s, 'Member'), 'address.city'));
  assert.equal(col(table(s, 'Loan'), 'returnedAt').nullable, true);
});

test('Salesforce describe JSON: lookups, polymorphic, master-detail, picklists', () => {
  const s = load('salesforce-describe.json');
  assert.equal(s.source.format, 'salesforce');
  const inv = table(s, 'Invoice__c');
  assert.equal(fk(inv, 'Opportunity__c').masterDetail, true);
  assert.equal(inv.foreignKeys.filter((f) => f.columns[0] === 'WhoId__c').length, 2);
  assert.deepEqual(col(table(s, 'Account'), 'Customer_Tier__c').enumValues, ['Bronze', 'Silver', 'Gold']);
  assert.equal(col(inv, 'Days_Overdue__c').meta.calculated, true);
});

test('MongoDB export: collections, embedded arrays, validator enums, indexes', () => {
  const s = load('mongodb-shop.json');
  assert.equal(s.source.dialect, 'mongodb');
  const orders = table(s, 'orders');
  assert.equal(orders.kind, 'collection');
  assert.equal(orders.rowCount, 98234);
  assert.ok(table(s, 'orders.items'));
  assert.deepEqual(col(table(s, 'users'), 'role').enumValues, ['customer', 'admin', 'support']);
  assert.ok(table(s, 'users').indexes.some((i) => i.unique && i.columns[0] === 'email'));
});

test('metadata CSV from the PostgreSQL export query matches the DDL', () => {
  const a = load('ecommerce-postgres.sql');
  const b = load('metadata-postgres.csv');
  assert.equal(b.source.format, 'csv-metadata');
  assert.equal(b.source.dialect, 'postgres');
  const sig = (s) => s.tables.map((t) => `${t.name}:${t.primaryKey}:${t.foreignKeys.map((f) => f.columns + '>' + f.refTable).sort()}`).sort();
  assert.deepEqual(sig(b), sig(a));
});

test('data CSV: type inference, stats, inferred primary key', () => {
  const s = load('orders.csv');
  const t = s.tables[0];
  assert.equal(t.name, 'orders');
  assert.deepEqual(t.primaryKey, ['order_id']);
  assert.equal(col(t, 'total').category, 'decimal');
  assert.equal(col(t, 'order_date').category, 'datetime');
  assert.equal(col(t, 'shipped_at').nullable, true);
  assert.deepEqual([...col(t, 'status').enumValues].sort(), ['cancelled', 'delivered', 'paid', 'shipped']);
  assert.equal(col(t, 'total').unique, false, 'distinct sample values are not reported as a constraint');
});

test('Salesforce FieldDefinition CSV', () => {
  const csv = '"EntityDefinition.QualifiedApiName","QualifiedApiName","Label","DataType","IsNillable"\n"Contact","Id","Contact ID","Lookup()","false"\n"Contact","AccountId","Account ID","Lookup(Account)","true"\n"Account","Id","Account ID","Lookup()","false"\n"Account","Name","Account Name","Text(255)","false"';
  const s = parseText(csv, 'fields.csv');
  assert.equal(s.source.dialect, 'salesforce');
  assert.deepEqual(table(s, 'Contact').primaryKey, ['Id']);
  assert.equal(fk(table(s, 'Contact'), 'AccountId').refTable, 'Account');
  assert.equal(col(table(s, 'Account'), 'Name').rawType, 'string(255)');
});

test('rejects text that is not a schema', () => {
  const s = parseText('hello world', 'x.txt');
  assert.equal(s.tables.length, 0);
  assert.ok(s.notes.length);
});

test('JSON column lists (DBeaver/DataGrip export of ALL_TAB_COLUMNS or information_schema)', () => {
  const rows = [
    { OWNER: 'HR', TABLE_NAME: 'DEPARTMENTS', COLUMN_NAME: 'DEPARTMENT_ID', DATA_TYPE: 'NUMBER', DATA_PRECISION: 4, DATA_SCALE: 0, NULLABLE: 'N', COLUMN_ID: 1 },
    { OWNER: 'HR', TABLE_NAME: 'DEPARTMENTS', COLUMN_NAME: 'DEPARTMENT_NAME', DATA_TYPE: 'VARCHAR2', DATA_LENGTH: 30, NULLABLE: 'N', COLUMN_ID: 2 },
    { OWNER: 'HR', TABLE_NAME: 'EMPLOYEES', COLUMN_NAME: 'EMPLOYEE_ID', DATA_TYPE: 'NUMBER', DATA_PRECISION: 6, DATA_SCALE: 0, NULLABLE: 'N', COLUMN_ID: 1 },
    { OWNER: 'HR', TABLE_NAME: 'EMPLOYEES', COLUMN_NAME: 'DEPARTMENT_ID', DATA_TYPE: 'NUMBER', DATA_PRECISION: 4, DATA_SCALE: 0, NULLABLE: 'Y', COLUMN_ID: 2 },
  ];
  for (const doc of [{ ALL_TAB_COLUMNS: rows }, rows]) {
    const s = parseText(JSON.stringify(doc), 'ALL_TAB_COLUMNS_202610151215.json');
    assert.equal(s.source.format, 'json-metadata');
    assert.equal(s.source.dialect, 'oracle');
    assert.deepEqual(s.tables.map((t) => t.name).sort(), ['DEPARTMENTS', 'EMPLOYEES']);
    assert.equal(col(table(s, 'DEPARTMENTS'), 'DEPARTMENT_ID').rawType, 'NUMBER(4,0)');
    assert.equal(col(table(s, 'DEPARTMENTS'), 'DEPARTMENT_NAME').rawType, 'VARCHAR2(30)');
    assert.equal(col(table(s, 'EMPLOYEES'), 'DEPARTMENT_ID').nullable, true);
    assert.deepEqual(table(s, 'EMPLOYEES').primaryKey, ['EMPLOYEE_ID']);
  }
});

test('JSON table-definition layouts', () => {
  const a = parseText(JSON.stringify({ tables: [{ name: 'users', columns: [{ name: 'id', type: 'int', primary_key: true }] }, { name: 'orders', columns: [{ name: 'id', type: 'int', primary_key: true }, { name: 'user_id', type: 'int', references: 'users.id' }] }] }), 'x.json');
  assert.equal(a.source.format, 'json-tables');
  assert.equal(fk(table(a, 'orders'), 'user_id').refTable, 'users');
  const b = parseText(JSON.stringify({ users: { columns: { id: 'uuid', email: { type: 'text', required: true } } } }), 'y.json');
  assert.equal(col(table(b, 'users'), 'email').nullable, false);
  const c = parseText(JSON.stringify([{ id: 1, name: 'x' }, { id: 2, name: 'y' }]), 'people.json');
  assert.equal(c.source.format, 'json-data', 'plain records are still treated as data');
});
