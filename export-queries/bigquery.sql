-- =============================================================================
-- Any Schema - Google BigQuery schema export
-- Read-only. Replace `my-project.my_dataset` (4 places) with your dataset.
-- Includes primary/foreign keys declared on tables (BigQuery stores them as
-- unenforced constraints) and column/table descriptions.
--
-- Export:
--   * Console: run, then "Save results" -> CSV (local file).
--   * bq CLI:
--       bq query --nouse_legacy_sql --format=csv --max_rows=100000 "$(cat bigquery.sql)" > schema.csv
-- =============================================================================
WITH
cols AS (
  SELECT * FROM `my-project.my_dataset`.INFORMATION_SCHEMA.COLUMNS
),
descs AS (
  SELECT table_name, column_name, description
  FROM `my-project.my_dataset`.INFORMATION_SCHEMA.COLUMN_FIELD_PATHS
  WHERE field_path = column_name
),
keys AS (
  SELECT k.table_name, k.column_name, tc.constraint_type, k.constraint_name
  FROM `my-project.my_dataset`.INFORMATION_SCHEMA.KEY_COLUMN_USAGE k
  JOIN `my-project.my_dataset`.INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
    ON tc.constraint_name = k.constraint_name AND tc.table_name = k.table_name
),
refs AS (
  SELECT constraint_name, ANY_VALUE(table_schema) AS ref_schema,
         ANY_VALUE(table_name) AS ref_table, ANY_VALUE(column_name) AS ref_column
  FROM `my-project.my_dataset`.INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE
  GROUP BY constraint_name
),
tbls AS (
  SELECT t.table_name, t.table_type,
         (SELECT TRIM(o.option_value, '"')
            FROM `my-project.my_dataset`.INFORMATION_SCHEMA.TABLE_OPTIONS o
           WHERE o.table_name = t.table_name AND o.option_name = 'description') AS table_comment
  FROM `my-project.my_dataset`.INFORMATION_SCHEMA.TABLES t
)
SELECT
  c.table_schema                                        AS table_schema,
  c.table_name                                          AS table_name,
  t.table_type                                          AS table_type,
  c.ordinal_position                                    AS ordinal_position,
  c.column_name                                         AS column_name,
  c.data_type                                           AS data_type,
  c.is_nullable                                         AS is_nullable,
  c.column_default                                      AS column_default,
  IF(pk.column_name IS NOT NULL, 'YES', 'NO')           AS is_primary_key,
  fk.constraint_name                                    AS fk_constraint_name,
  r.ref_schema                                          AS fk_ref_schema,
  r.ref_table                                           AS fk_ref_table,
  r.ref_column                                          AS fk_ref_column,
  d.description                                         AS column_comment,
  t.table_comment                                       AS table_comment
FROM cols c
JOIN tbls t USING (table_name)
LEFT JOIN descs d ON d.table_name = c.table_name AND d.column_name = c.column_name
LEFT JOIN keys pk ON pk.table_name = c.table_name AND pk.column_name = c.column_name AND pk.constraint_type = 'PRIMARY KEY'
LEFT JOIN keys fk ON fk.table_name = c.table_name AND fk.column_name = c.column_name AND fk.constraint_type = 'FOREIGN KEY'
LEFT JOIN refs r  ON r.constraint_name = fk.constraint_name
ORDER BY c.table_name, c.ordinal_position;
