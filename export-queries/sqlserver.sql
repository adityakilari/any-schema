-- =============================================================================
-- Any Schema - Microsoft SQL Server / Azure SQL schema export
-- Works on SQL Server 2012+, Azure SQL Database and Azure SQL Managed Instance.
-- Read-only. Run it while connected to the database you want to document.
--
-- Export options:
--   * SSMS / Azure Data Studio: run, right-click the results grid,
--     "Save Results As..." -> CSV.
--   * PowerShell (SqlServer module):
--       Invoke-Sqlcmd -ServerInstance HOST -Database DBNAME -InputFile sqlserver.sql |
--         Export-Csv schema.csv -NoTypeInformation
--   * sqlcmd:
--       sqlcmd -S HOST -d DBNAME -E -i sqlserver.sql -s"," -W -o schema.csv
--     (the dashed separator line sqlcmd adds is ignored by Any Schema)
-- =============================================================================
SET NOCOUNT ON;

SELECT
  s.name                                              AS table_schema,
  o.name                                              AS table_name,
  CASE o.type WHEN 'V' THEN 'VIEW' ELSE 'TABLE' END   AS table_type,
  c.column_id                                         AS ordinal_position,
  c.name                                              AS column_name,
  CASE
    WHEN ty.name IN ('varchar', 'char', 'varbinary', 'binary')
      THEN ty.name + '(' + CASE WHEN c.max_length = -1 THEN 'max' ELSE CAST(c.max_length AS varchar(10)) END + ')'
    WHEN ty.name IN ('nvarchar', 'nchar')
      THEN ty.name + '(' + CASE WHEN c.max_length = -1 THEN 'max' ELSE CAST(c.max_length / 2 AS varchar(10)) END + ')'
    WHEN ty.name IN ('decimal', 'numeric')
      THEN ty.name + '(' + CAST(c.precision AS varchar(10)) + ',' + CAST(c.scale AS varchar(10)) + ')'
    WHEN ty.name IN ('datetime2', 'datetimeoffset', 'time')
      THEN ty.name + '(' + CAST(c.scale AS varchar(10)) + ')'
    ELSE ty.name
  END                                                 AS data_type,
  CASE WHEN c.is_nullable = 1 THEN 'YES' ELSE 'NO' END AS is_nullable,
  COALESCE(dc.definition, cc.definition)              AS column_default,
  CASE WHEN EXISTS (
         SELECT 1 FROM sys.indexes i
         JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
         WHERE i.object_id = c.object_id AND i.is_primary_key = 1 AND ic.column_id = c.column_id)
       THEN 'YES' ELSE 'NO' END                       AS is_primary_key,
  CASE WHEN EXISTS (
         SELECT 1 FROM sys.indexes i
         JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
         WHERE i.object_id = c.object_id AND i.is_unique = 1 AND i.is_primary_key = 0
           AND ic.column_id = c.column_id AND i.has_filter = 0
           AND (SELECT COUNT(*) FROM sys.index_columns x
                WHERE x.object_id = i.object_id AND x.index_id = i.index_id AND x.key_ordinal > 0) = 1)
       THEN 'YES' ELSE 'NO' END                       AS is_unique,
  CASE WHEN c.is_identity = 1 THEN 'YES' ELSE 'NO' END AS is_auto_increment,
  CASE WHEN EXISTS (
         SELECT 1 FROM sys.index_columns ic
         WHERE ic.object_id = c.object_id AND ic.column_id = c.column_id AND ic.key_ordinal = 1)
       THEN 'YES' ELSE 'NO' END                       AS is_indexed,
  fk.fk_name                                          AS fk_constraint_name,
  fk.ref_schema                                       AS fk_ref_schema,
  fk.ref_table                                        AS fk_ref_table,
  fk.ref_column                                       AS fk_ref_column,
  CAST(ep.value AS nvarchar(4000))                    AS column_comment,
  CAST(tp.value AS nvarchar(4000))                    AS table_comment
FROM sys.objects o
JOIN sys.schemas s   ON s.schema_id = o.schema_id
JOIN sys.columns c   ON c.object_id = o.object_id
JOIN sys.types ty    ON ty.user_type_id = c.user_type_id
LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
LEFT JOIN sys.computed_columns cc    ON cc.object_id = c.object_id AND cc.column_id = c.column_id
OUTER APPLY (
  SELECT TOP 1
         f.name   AS fk_name,
         rs.name  AS ref_schema,
         ro.name  AS ref_table,
         rc.name  AS ref_column
  FROM sys.foreign_key_columns fkc
  JOIN sys.foreign_keys f ON f.object_id = fkc.constraint_object_id
  JOIN sys.objects ro     ON ro.object_id = fkc.referenced_object_id
  JOIN sys.schemas rs     ON rs.schema_id = ro.schema_id
  JOIN sys.columns rc     ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
  WHERE fkc.parent_object_id = c.object_id AND fkc.parent_column_id = c.column_id
  ORDER BY f.name
) fk
LEFT JOIN sys.extended_properties ep
  ON ep.class = 1 AND ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = 'MS_Description'
LEFT JOIN sys.extended_properties tp
  ON tp.class = 1 AND tp.major_id = o.object_id AND tp.minor_id = 0 AND tp.name = 'MS_Description'
WHERE o.type IN ('U', 'V')
  AND o.is_ms_shipped = 0
ORDER BY s.name, o.name, c.column_id;
