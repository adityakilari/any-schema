-- =============================================================================
-- Any Schema - SQLite schema export
-- Needs SQLite 3.16+ (pragma table-valued functions). Read-only.
--
-- Export to CSV with the sqlite3 shell:
--   sqlite3 -header -csv app.db < sqlite.sql > schema.csv
-- Or simply dump the DDL, which Any Schema also reads:
--   sqlite3 app.db .schema > schema.sql
-- =============================================================================
SELECT
  'main'                                                   AS table_schema,
  m.name                                                   AS table_name,
  UPPER(m.type)                                            AS table_type,
  p.cid + 1                                                AS ordinal_position,
  p.name                                                   AS column_name,
  p.type                                                   AS data_type,
  CASE WHEN p."notnull" = 1 THEN 'NO' ELSE 'YES' END       AS is_nullable,
  p.dflt_value                                             AS column_default,
  CASE WHEN p.pk > 0 THEN 'YES' ELSE 'NO' END              AS is_primary_key,
  CASE WHEN EXISTS (
         SELECT 1 FROM pragma_index_list(m.name) il
         JOIN pragma_index_info(il.name) ii
         WHERE il."unique" = 1 AND il.origin <> 'pk' AND ii.name = p.name
           AND (SELECT COUNT(*) FROM pragma_index_info(il.name)) = 1)
       THEN 'YES' ELSE 'NO' END                            AS is_unique,
  CASE WHEN p.pk = 1 AND UPPER(p.type) = 'INTEGER'
         AND (SELECT COUNT(*) FROM pragma_table_info(m.name) x WHERE x.pk > 0) = 1
       THEN 'YES' ELSE 'NO' END                            AS is_auto_increment,
  CASE WHEN p.pk = 1 OR EXISTS (
         SELECT 1 FROM pragma_index_list(m.name) il
         JOIN pragma_index_info(il.name) ii
         WHERE ii.name = p.name AND ii.seqno = 0)
       THEN 'YES' ELSE 'NO' END                            AS is_indexed,
  CASE WHEN fk."table" IS NOT NULL THEN 'fk_' || m.name || '_' || fk.id END AS fk_constraint_name,
  CASE WHEN fk."table" IS NOT NULL THEN 'main' END         AS fk_ref_schema,
  fk."table"                                               AS fk_ref_table,
  fk."to"                                                  AS fk_ref_column
FROM sqlite_master m
JOIN pragma_table_info(m.name) p
LEFT JOIN pragma_foreign_key_list(m.name) fk ON fk."from" = p.name
WHERE m.type IN ('table', 'view')
  AND m.name NOT LIKE 'sqlite\_%' ESCAPE '\'
ORDER BY m.name, p.cid;
