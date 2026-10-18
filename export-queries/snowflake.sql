-- =============================================================================
-- Any Schema - Snowflake schema export
-- Read-only. Run it with a warehouse selected and the database in context:
--   USE DATABASE MY_DB;
--
-- Option A (recommended): full DDL including primary/foreign keys and comments.
-- Snowflake stores (but does not enforce) PK/FK constraints; GET_DDL returns them.
-- Copy the single result cell into a file named schema.sql:
--
--   SELECT GET_DDL('SCHEMA', 'MY_DB.PUBLIC', TRUE);
--
--   (or GET_DDL('DATABASE', 'MY_DB', TRUE) for every schema)
--
-- Option B: the query below returns one row per column in the Any Schema CSV
-- format (no keys, because INFORMATION_SCHEMA has no column-level FK mapping).
-- Download the result grid as CSV from Snowsight, or with SnowSQL:
--   snowsql -c my_conn -f snowflake.sql -o output_format=csv -o header=true \
--           -o timing=false -o friendly=false > schema.csv
-- =============================================================================
SELECT
  c.table_schema                               AS table_schema,
  c.table_name                                 AS table_name,
  t.table_type                                 AS table_type,
  c.ordinal_position                           AS ordinal_position,
  c.column_name                                AS column_name,
  CASE
    WHEN c.data_type = 'TEXT' AND c.character_maximum_length < 16777216
      THEN 'VARCHAR(' || c.character_maximum_length || ')'
    WHEN c.data_type = 'NUMBER'
      THEN 'NUMBER(' || c.numeric_precision || ',' || c.numeric_scale || ')'
    ELSE c.data_type
  END                                          AS data_type,
  c.is_nullable                                AS is_nullable,
  c.column_default                             AS column_default,
  IFF(c.is_identity = 'YES', 'YES', 'NO')      AS is_auto_increment,
  c.comment                                    AS column_comment,
  t.comment                                    AS table_comment
FROM information_schema.columns c
JOIN information_schema.tables t
  ON t.table_catalog = c.table_catalog
 AND t.table_schema  = c.table_schema
 AND t.table_name    = c.table_name
WHERE c.table_schema <> 'INFORMATION_SCHEMA'
ORDER BY c.table_schema, c.table_name, c.ordinal_position;
