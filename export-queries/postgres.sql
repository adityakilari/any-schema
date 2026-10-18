-- =============================================================================
-- Any Schema - PostgreSQL schema export
-- Works on PostgreSQL 11+ (also Amazon RDS/Aurora, Supabase, Neon, Cloud SQL,
-- Azure Database for PostgreSQL, TimescaleDB). Read-only: it only queries the catalog.
--
-- Output: one row per column in the Any Schema metadata-CSV format.
--
-- Export to CSV with psql (12+):
--   psql "postgresql://USER@HOST:5432/DBNAME" --csv -f postgres.sql -o schema.csv
-- Or run it in pgAdmin / DBeaver / DataGrip and use "Export results -> CSV".
--
-- To limit to one schema, change the WHERE clause at the bottom, e.g.
--   AND n.nspname = 'public'
-- =============================================================================
WITH pk AS (
  SELECT con.conrelid, k.attnum
  FROM pg_constraint con
  CROSS JOIN LATERAL unnest(con.conkey) AS k(attnum)
  WHERE con.contype = 'p'
),
uq AS (
  SELECT con.conrelid, con.conkey[1] AS attnum
  FROM pg_constraint con
  WHERE con.contype = 'u' AND array_length(con.conkey, 1) = 1
  UNION
  SELECT i.indrelid, i.indkey[0]
  FROM pg_index i
  WHERE i.indisunique AND NOT i.indisprimary AND i.indnatts = 1
    AND i.indexprs IS NULL AND i.indpred IS NULL
),
fk AS (
  SELECT DISTINCT ON (con.conrelid, k.attnum)
         con.conrelid, k.attnum, con.conname,
         fn.nspname AS ref_schema, fc.relname AS ref_table, fa.attname AS ref_column
  FROM pg_constraint con
  CROSS JOIN LATERAL unnest(con.conkey, con.confkey) AS k(attnum, ref_attnum)
  JOIN pg_class fc     ON fc.oid = con.confrelid
  JOIN pg_namespace fn ON fn.oid = fc.relnamespace
  JOIN pg_attribute fa ON fa.attrelid = con.confrelid AND fa.attnum = k.ref_attnum
  WHERE con.contype = 'f'
  ORDER BY con.conrelid, k.attnum, con.conname
)
SELECT
  n.nspname                                        AS table_schema,
  c.relname                                        AS table_name,
  CASE c.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW'
                 WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END AS table_type,
  a.attnum                                         AS ordinal_position,
  a.attname                                        AS column_name,
  format_type(a.atttypid, a.atttypmod)             AS data_type,
  CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END  AS is_nullable,
  pg_get_expr(d.adbin, d.adrelid)                  AS column_default,
  CASE WHEN pk.attnum IS NOT NULL THEN 'YES' ELSE 'NO' END AS is_primary_key,
  CASE WHEN uq.attnum IS NOT NULL THEN 'YES' ELSE 'NO' END AS is_unique,
  CASE WHEN a.attidentity <> '' OR pg_get_expr(d.adbin, d.adrelid) LIKE 'nextval(%'
       THEN 'YES' ELSE 'NO' END                    AS is_auto_increment,
  CASE WHEN EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indkey[0] = a.attnum)
       THEN 'YES' ELSE 'NO' END                    AS is_indexed,
  fk.conname                                       AS fk_constraint_name,
  fk.ref_schema                                    AS fk_ref_schema,
  fk.ref_table                                     AS fk_ref_table,
  fk.ref_column                                    AS fk_ref_column,
  (SELECT string_agg(e.enumlabel, '|' ORDER BY e.enumsortorder)
     FROM pg_enum e WHERE e.enumtypid = a.atttypid) AS enum_values,
  col_description(c.oid, a.attnum)                 AS column_comment,
  obj_description(c.oid, 'pg_class')               AS table_comment
FROM pg_class c
JOIN pg_namespace n  ON n.oid = c.relnamespace
JOIN pg_attribute a  ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
LEFT JOIN pk ON pk.conrelid = c.oid AND pk.attnum = a.attnum
LEFT JOIN uq ON uq.conrelid = c.oid AND uq.attnum = a.attnum
LEFT JOIN fk ON fk.conrelid = c.oid AND fk.attnum = a.attnum
WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND NOT c.relispartition
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg\_toast%'
  AND n.nspname NOT LIKE 'pg\_temp%'
ORDER BY n.nspname, c.relname, a.attnum;
