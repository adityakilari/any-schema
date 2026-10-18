-- =============================================================================
-- Any Schema - generic INFORMATION_SCHEMA export (fallback)
-- For databases that implement the SQL-standard INFORMATION_SCHEMA but are not
-- listed separately: Amazon Redshift, CockroachDB, YugabyteDB, Azure Synapse,
-- Databricks SQL (Unity Catalog), Trino/Presto, H2, HSQLDB, MariaDB, DuckDB...
-- Gives table/column/type/nullability/defaults. Keys are added by Any Schema's
-- name-based inference; prefer the database-specific file when there is one.
--
-- Change 'public' to your schema name. Export the result grid as CSV.
-- =============================================================================
SELECT
  c.table_schema       AS table_schema,
  c.table_name         AS table_name,
  t.table_type         AS table_type,
  c.ordinal_position   AS ordinal_position,
  c.column_name        AS column_name,
  c.data_type          AS data_type,
  c.character_maximum_length AS length,
  c.numeric_precision  AS precision,
  c.numeric_scale      AS scale,
  c.is_nullable        AS is_nullable,
  c.column_default     AS column_default
FROM information_schema.columns c
JOIN information_schema.tables t
  ON t.table_schema = c.table_schema AND t.table_name = c.table_name
WHERE c.table_schema = 'public'
ORDER BY c.table_schema, c.table_name, c.ordinal_position;
