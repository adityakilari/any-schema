import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseText, parseInputs } from '../src/core/parse.js';
import { analyze } from '../src/core/analyze.js';

const sample = (f) => fs.readFileSync(new URL(`../samples/${f}`, import.meta.url), 'utf8');
const run = (f) => { const s = parseText(sample(f), f); return [s, analyze(s)]; };
const t = (a, n) => a.tables.find((x) => x.name === n);
const c = (a, tn, cn) => t(a, tn).columns.find((x) => x.name === cn);
const rules = (a) => a.findings.map((f) => `${f.rule}:${f.table || ''}:${f.column || ''}`);

test('table roles', () => {
  const [, a] = run('ecommerce-postgres.sql');
  assert.equal(t(a, 'product_tags').role, 'junction');
  assert.equal(t(a, 'tags').role, 'lookup');
  assert.equal(t(a, 'audit_log').role, 'log');
  assert.equal(t(a, 'order_items').role, 'detail');
  assert.equal(t(a, 'orders').role, 'transaction');
  assert.equal(t(a, 'customers').role, 'core');
  assert.equal(t(a, 'customer_order_totals').role, 'view');
  assert.equal(t(a, 'reviews').role, 'entity');
  const [, hr] = run('hr-oracle.sql');
  assert.equal(t(hr, 'DEPARTMENTS').role !== 'junction', true);
});

test('relationships: declared, inferred, self-reference, many-to-many', () => {
  const [, a] = run('ecommerce-postgres.sql');
  const inferred = a.relationships.filter((r) => r.source === 'inferred').map((r) => `${r.from.name}.${r.from.columns[0]}>${r.to.name}`);
  assert.deepEqual(inferred.sort(), ['reviews.customer_id>customers', 'reviews.product_id>products']);
  assert.ok(a.relationships.some((r) => r.self && r.from.name === 'categories'));
  assert.deepEqual(a.manyToMany.map((m) => m.via), ['product_tags']);
  const [, hr] = run('hr-oracle.sql');
  const mgr = hr.relationships.find((r) => r.from.name === 'DEPARTMENTS' && r.from.columns[0] === 'MANAGER_ID');
  assert.equal(mgr.to.name, 'EMPLOYEES', 'manager_id points at employees, not departments');
});

test('column explanations', () => {
  const [, a] = run('ecommerce-postgres.sql');
  assert.match(c(a, 'orders', 'customer_id').main, /Foreign key → `customers.id`/);
  assert.match(c(a, 'orders', 'status').main, /One of: `pending`/);
  assert.match(c(a, 'customers', 'deleted_at').main, /Soft-delete/);
  assert.match(c(a, 'products', 'price').main, /floating point/);
  assert.match(c(a, 'orders', 'shipped_at').main, /When the order was shipped/);
  assert.match(c(a, 'payments', 'paid_at').main, /When the payment was paid/);
  assert.match(c(a, 'orders', 'shipping_address_id').main, /its shipping address/);
  assert.match(c(a, 'customers', 'email').main, /unique/);
  assert.ok(c(a, 'customers', 'email').tags.includes('PII'));
  assert.equal(c(a, 'customers', 'marketing_opt_in').documented, 'Consent to receive marketing email (GDPR).');
});

test('findings with fixes', () => {
  const [, a] = run('ecommerce-postgres.sql');
  const r = rules(a);
  for (const expected of ['no-primary-key:audit_log:', 'money-as-float:products:price', 'plaintext-password:customers:password', 'unindexed-foreign-key:addresses:customer_id', 'missing-foreign-key:reviews:product_id', 'timestamp-without-tz::']) {
    assert.ok(r.includes(expected), `expected finding ${expected}`);
  }
  assert.ok(!r.includes('unindexed-foreign-key:orders:customer_id'), 'indexed FK is not flagged');
  const idx = a.findings.find((f) => f.rule === 'unindexed-foreign-key' && f.table === 'addresses');
  assert.equal(idx.fix, 'CREATE INDEX idx_addresses_customer_id ON public.addresses (customer_id);');
  assert.equal(a.findings[0].severity, 'high');
});

test('MySQL does not get unindexed-FK findings (InnoDB indexes FKs)', () => {
  const [, a] = run('blog-mysql.sql');
  assert.ok(!rules(a).some((x) => x.startsWith('unindexed-foreign-key')));
  assert.ok(rules(a).some((x) => x.startsWith('mixed-naming')));
});

test('Prisma findings use Prisma syntax', () => {
  const [, a] = run('saas.prisma');
  const f = a.findings.find((x) => x.rule === 'unindexed-foreign-key');
  assert.match(f.fix, /@@index\(\[/);
});

test('privacy scan', () => {
  const [, a] = run('ecommerce-postgres.sql');
  const cats = Object.fromEntries(a.privacy.map((p) => [`${p.table}.${p.column}`, p.category]));
  assert.equal(cats['customers.password'], 'Credential');
  assert.equal(cats['customers.date_of_birth'], 'Date of birth');
  assert.equal(cats['addresses.street'], 'Address');
  assert.equal(cats['customers.marketing_opt_in'], undefined);
});

test('domain guess and summary', () => {
  const [, a] = run('salesforce-describe.json');
  assert.equal(a.domain.name, 'CRM');
  assert.match(a.summary, /4 objects/);
  const [, b] = run('hr-oracle.sql');
  assert.equal(b.domain.name, 'HR / people');
});

test('multi-file data CSVs infer cross-file relationships', () => {
  const s = parseInputs(['customers.csv', 'orders.csv'].map((f) => ({ name: f, text: sample(f) })));
  const a = analyze(s);
  assert.ok(a.relationships.some((r) => r.from.name === 'orders' && r.to.name === 'customers' && r.source === 'inferred'));
  assert.equal(a.findings.filter((f) => f.rule === 'no-primary-key').length, 0);
});

test('every sample analyzes without throwing', () => {
  for (const f of fs.readdirSync(new URL('../samples/', import.meta.url))) {
    const [s, a] = run(f);
    assert.ok(s.tables.length > 0, f);
    assert.equal(a.tables.length, s.tables.length, f);
    for (const tb of a.tables) for (const col of tb.columns) assert.ok(col.main && !/undefined|null/.test(col.main), `${f} ${tb.name}.${col.name}: ${col.main}`);
  }
});
