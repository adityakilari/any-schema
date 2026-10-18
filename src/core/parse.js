// Format detection + dispatch. Every parser returns the canonical model from model.js.
import { parseSql } from './parsers/sql.js';
import { parsePrisma } from './parsers/prisma.js';
import { parseJson } from './parsers/json.js';
import { parseCsv } from './parsers/csv.js';
import { mergeSchemas } from './model.js';

export const FORMATS = {
  auto: 'Auto-detect',
  sql: 'SQL DDL',
  prisma: 'Prisma schema',
  json: 'JSON (JSON Schema, OpenAPI, Salesforce, MongoDB, sample data)',
  csv: 'CSV / TSV (metadata export or data)',
};

export function detectFormat(text, fileName = '') {
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  if (ext === 'prisma') return 'prisma';
  if (['sql', 'ddl', 'pgsql', 'psql'].includes(ext)) return 'sql';
  if (['csv', 'tsv', 'txt'].includes(ext) && !/^\s*create\s/im.test(text.slice(0, 5000))) return 'csv';
  if (['json', 'jsonl', 'ndjson'].includes(ext)) return 'json';
  const head = text.replace(/^﻿/, '').trimStart();
  if (head[0] === '{' || head[0] === '[') {
    try { JSON.parse(head); return 'json'; } catch { /* keep looking */ }
    if (/^\{[\s\S]*\}\s*\n\s*\{/.test(head.slice(0, 20000))) return 'json'; // JSON Lines
  }
  if (/^\s*(model|enum|datasource|generator)\s+\w+\s*\{/m.test(text) && /^\s*model\s+\w+\s*\{/m.test(text)) return 'prisma';
  if (/\bcreate\s+(or\s+replace\s+)?((global|local|temporary|temp|transient|unlogged|external)\s+)*(table|view)\b/i.test(text)) return 'sql';
  return 'csv';
}

export function parseText(text, fileName = 'input', format = 'auto') {
  const fmt = format === 'auto' ? detectFormat(text, fileName) : format;
  switch (fmt) {
    case 'sql': return parseSql(text, fileName);
    case 'prisma': return parsePrisma(text, fileName);
    case 'json': return parseJson(text, fileName);
    case 'csv': return parseCsv(text, fileName);
    default: throw new Error(`Unknown format: ${fmt}`);
  }
}

/** inputs: [{ text, name, format? }] -> merged canonical schema */
export function parseInputs(inputs, format = 'auto') {
  const parsed = inputs.map((i) => parseText(i.text, i.name, i.format || format));
  return mergeSchemas(parsed);
}
