-- =============================================================================
-- Any Schema - Oracle schema export
-- Works on Oracle 12c+ (19c, 21c, 23ai, Autonomous Database). Read-only.
--
-- Exports the schema you are logged in as. To export another schema you can
-- read, replace SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') with 'HR' (upper case).
--
-- Export options:
--   * SQL Developer: run as script (F5) or statement (Ctrl+Enter), right-click
--     the results -> Export -> format "csv".
--   * SQLcl:
--       SET SQLFORMAT csv
--       SPOOL schema.csv
--       @oracle.sql
--       SPOOL OFF
--   * SQL*Plus 12.2+:
--       SET MARKUP CSV ON QUOTE ON
--       SET FEEDBACK OFF
--       SET PAGESIZE 0 EMBEDDED ON
--       SPOOL schema.csv
--       @oracle.sql
--       SPOOL OFF
--
-- Column defaults are not exported because DATA_DEFAULT is a LONG column that
-- many clients cannot convert. Use oracle-ddl.sql if you need defaults.
-- =============================================================================
SELECT
  c.owner                                                      AS table_schema,
  c.table_name                                                 AS table_name,
  NVL(tc.table_type, 'TABLE')                                  AS table_type,
  c.column_id                                                  AS ordinal_position,
  c.column_name                                                AS column_name,
  CASE
    WHEN c.data_type IN ('VARCHAR2', 'NVARCHAR2', 'CHAR', 'NCHAR')
      THEN c.data_type || '(' || c.char_length || ')'
    WHEN c.data_type = 'RAW'
      THEN 'RAW(' || c.data_length || ')'
    WHEN c.data_type = 'NUMBER' AND c.data_precision IS NOT NULL
      THEN 'NUMBER(' || c.data_precision || ',' || NVL(c.data_scale, 0) || ')'
    WHEN c.data_type = 'NUMBER' AND c.data_scale = 0
      THEN 'NUMBER(*,0)'
    ELSE c.data_type
  END                                                          AS data_type,
  CASE c.nullable WHEN 'Y' THEN 'YES' ELSE 'NO' END            AS is_nullable,
  CASE WHEN EXISTS (
         SELECT 1 FROM all_constraints k
         JOIN all_cons_columns kc ON kc.owner = k.owner AND kc.constraint_name = k.constraint_name
         WHERE k.constraint_type = 'P' AND k.owner = c.owner AND k.table_name = c.table_name
           AND kc.column_name = c.column_name)
       THEN 'YES' ELSE 'NO' END                                AS is_primary_key,
  CASE WHEN EXISTS (
         SELECT 1 FROM all_constraints k
         JOIN all_cons_columns kc ON kc.owner = k.owner AND kc.constraint_name = k.constraint_name
         WHERE k.constraint_type = 'U' AND k.owner = c.owner AND k.table_name = c.table_name
           AND kc.column_name = c.column_name
           AND (SELECT COUNT(*) FROM all_cons_columns x
                WHERE x.owner = k.owner AND x.constraint_name = k.constraint_name) = 1)
       THEN 'YES' ELSE 'NO' END                                AS is_unique,
  c.identity_column                                            AS is_auto_increment,
  CASE WHEN EXISTS (
         SELECT 1 FROM all_ind_columns ic
         WHERE ic.table_owner = c.owner AND ic.table_name = c.table_name
           AND ic.column_name = c.column_name AND ic.column_position = 1)
       THEN 'YES' ELSE 'NO' END                                AS is_indexed,
  fk.constraint_name                                           AS fk_constraint_name,
  fk.r_owner                                                   AS fk_ref_schema,
  fk.r_table                                                   AS fk_ref_table,
  fk.r_column                                                  AS fk_ref_column,
  cc.comments                                                  AS column_comment,
  tc.comments                                                  AS table_comment
FROM all_tab_columns c
LEFT JOIN all_col_comments cc
  ON cc.owner = c.owner AND cc.table_name = c.table_name AND cc.column_name = c.column_name
LEFT JOIN all_tab_comments tc
  ON tc.owner = c.owner AND tc.table_name = c.table_name
LEFT JOIN (
  SELECT fc.owner, fc.table_name, fcc.column_name, fc.constraint_name,
         rc.owner AS r_owner, rc.table_name AS r_table, rcc.column_name AS r_column,
         ROW_NUMBER() OVER (PARTITION BY fc.owner, fc.table_name, fcc.column_name
                            ORDER BY fc.constraint_name) AS rn
  FROM all_constraints fc
  JOIN all_cons_columns fcc ON fcc.owner = fc.owner AND fcc.constraint_name = fc.constraint_name
  JOIN all_constraints rc   ON rc.owner = fc.r_owner AND rc.constraint_name = fc.r_constraint_name
  JOIN all_cons_columns rcc ON rcc.owner = rc.owner AND rcc.constraint_name = rc.constraint_name
                           AND rcc.position = fcc.position
  WHERE fc.constraint_type = 'R'
) fk
  ON fk.owner = c.owner AND fk.table_name = c.table_name AND fk.column_name = c.column_name AND fk.rn = 1
WHERE c.owner = SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA')
  AND c.table_name NOT LIKE 'BIN$%'
ORDER BY c.table_name, c.column_id;
