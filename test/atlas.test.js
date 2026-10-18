import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseText } from '../src/core/parse.js';
import { analyze } from '../src/core/analyze.js';
import { words } from '../src/core/model.js';
import { assignModules } from '../src/core/modules.js';
import { findJoinPath } from '../src/core/paths.js';

const sample = (f) => fs.readFileSync(new URL(`../samples/${f}`, import.meta.url), 'utf8');
const run = (f) => { const s = parseText(sample(f), f); return [s, analyze(s)]; };
const col = (a, t, c) => a.tables.find((x) => x.name === t).columns.find((x) => x.name === c);
const rel = (a, t, c) => a.relationships.find((r) => r.from.name === t && r.from.columns.includes(c));

test('abbreviations are expanded for explanations', () => {
  assert.equal(words('LIC_EXPR_DT'), 'license expiration date');
  assert.equal(words('ROW_INS_TMSP'), 'row inserted timestamp');
  assert.equal(words('PAT_INS'), 'patient insurance');
  assert.equal(words('customerId'), 'customer id');
});

test('Oracle column export: keys, role prefixes, audit and polymorphic columns', () => {
  const [s, a] = run('clinic-oracle-columns.json');
  assert.equal(s.source.format, 'json-metadata');
  assert.equal(s.constraintsKnown, false);
  assert.deepEqual(s.tables.find((t) => t.name === 'ENC').primaryKey, ['ENC_ID']);
  assert.equal(rel(a, 'DEPT', 'MGR_SM_ID').to.name, 'SM');
  assert.equal(rel(a, 'BILL_ADJ', 'RSPBL_SM_ID').to.name, 'SM');
  assert.equal(rel(a, 'ENC', 'ATTND_PRV_ID').to.name, 'PRV');
  assert.match(col(a, 'DEPT', 'MGR_SM_ID').main, /staff member who is this department's manager/);
  assert.ok(col(a, 'ENC', 'ROW_INS_TMSP').tags.includes('Audit'));
  assert.match(col(a, 'ENC', 'ROW_INS_TMSP').main, /When this encounter record was inserted/);
  assert.ok(col(a, 'DOC_ATTCH', 'ENT_ID').tags.includes('Polymorphic'));
  assert.ok(!rel(a, 'DOC_ATTCH', 'ENT_ID'), 'polymorphic ids are not drawn as foreign keys');
  assert.equal(a.domain.name, 'healthcare');
  assert.ok(a.findings.some((f) => f.rule === 'money-as-float' && f.column === 'UNIT_PRICE_AMT'));
  assert.ok(!a.findings.some((f) => f.rule === 'no-primary-key'), 'no PK findings when the export has no constraints');
});

test('modules group large schemas by prefix', () => {
  const [s] = run('clinic-oracle-columns.json');
  const m = assignModules(s);
  const names = m.modules.map((x) => x.name);
  assert.ok(names.includes('Bill') && names.includes('Encounter') && names.includes('Patient'), names.join(','));
  assert.equal(m.modules.at(-1).id, 'other');
  assert.equal(m.of.get('CLINIC.ENC_DX'), 'p_ENC');
  const [small] = run('ecommerce-postgres.sql');
  assert.equal(assignModules(small).modules.length, 1);
  const [sf] = run('salesforce-describe.json');
  assert.equal(assignModules(sf, { singleUpTo: 0 }).modules.map((x) => x.id).sort().join(), 'custom,standard');
});

test('join paths with SQL', () => {
  const [s, a] = run('ecommerce-postgres.sql');
  const p = findJoinPath(s, a, 'public.payments', 'public.products');
  assert.deepEqual(p.steps.map((x) => x.to), ['public.orders', 'public.order_items', 'public.products']);
  assert.match(p.sql, /JOIN {3}public\.orders o ON p\.order_id = o\.id/);
  assert.match(p.sql, /JOIN {3}public\.products p2 ON oi\.product_id = p2\.id;$/);
  const [cs, ca] = run('clinic-oracle-columns.json');
  const q = findJoinPath(cs, ca, 'CLINIC.LAB_RSLT', 'CLINIC.PAT');
  assert.deepEqual(q.steps.map((x) => x.to), ['CLINIC.ORD_ITEM', 'CLINIC.ORD', 'CLINIC.ENC', 'CLINIC.PAT']);
  assert.equal(findJoinPath(cs, ca, 'CLINIC.TMP_PAT_LOAD', 'CLINIC.PAT'), null);
});
