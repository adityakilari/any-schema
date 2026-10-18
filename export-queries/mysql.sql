-- =============================================================================
-- Any Schema - MySQL / MariaDB schema export
-- Works on MySQL 5.7+, 8.x and MariaDB 10.2+ (also Amazon RDS/Aurora MySQL,
-- PlanetScale, Azure/Google Cloud SQL for MySQL). Read-only.
--
-- Exports the database you are connected to (DATABASE()). To export another
-- schema, replace DATABASE() with 'your_schema' in the two WHERE clauses.
--
-- Export to a file (tab-separated, Any Schema reads TSV too):
--   mysql -h HOST -u USER -p DBNAME --batch < mysql.sql > schema.tsv
-- Or run it in MySQL Workbench / DBeaver / HeidiSQL and export the result grid as CSV.
-- =============================================================================
SELECT
  c.TABLE_SCHEMA                                        AS table_schema,
  c.TABLE_NAME                                          AS table_name,
  t.TABLE_TYPE                                          AS table_type,
  c.ORDINAL_POSITION                                    AS ordinal_position,
  c.COLUMN_NAME                                         AS column_name,
  c.COLUMN_TYPE                                         AS data_type,
  c.IS_NULLABLE                                         AS is_nullable,
  c.COLUMN_DEFAULT                                      AS column_default,
  CASE WHEN c.COLUMN_KEY = 'PRI' THEN 'YES' ELSE 'NO' END AS is_primary_key,
  CASE WHEN c.COLUMN_KEY = 'UNI' THEN 'YES' ELSE 'NO' END AS is_unique,
  CASE WHEN c.EXTRA LIKE '%auto_increment%' THEN 'YES' ELSE 'NO' END AS is_auto_increment,
  CASE WHEN c.COLUMN_KEY IN ('PRI', 'UNI', 'MUL') THEN 'YES' ELSE 'NO' END AS is_indexed,
  k.CONSTRAINT_NAME                                     AS fk_constraint_name,
  k.REFERENCED_TABLE_SCHEMA                             AS fk_ref_schema,
  k.REFERENCED_TABLE_NAME                               AS fk_ref_table,
  k.REFERENCED_COLUMN_NAME                              AS fk_ref_column,
  NULLIF(c.COLUMN_COMMENT, '')                          AS column_comment,
  NULLIF(t.TABLE_COMMENT, '')                           AS table_comment
FROM information_schema.COLUMNS c
JOIN information_schema.TABLES t
  ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
LEFT JOIN information_schema.KEY_COLUMN_USAGE k
  ON  k.TABLE_SCHEMA = c.TABLE_SCHEMA
  AND k.TABLE_NAME   = c.TABLE_NAME
  AND k.COLUMN_NAME  = c.COLUMN_NAME
  AND k.REFERENCED_TABLE_NAME IS NOT NULL
WHERE c.TABLE_SCHEMA = DATABASE()
ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION;
