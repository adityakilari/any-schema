-- =============================================================================
-- Any Schema - Oracle DDL export (alternative to oracle.sql)
-- Produces CREATE TABLE statements with constraints and comments, without
-- storage clauses. Save the output as schema.sql and drop it into Any Schema.
--
-- Run in SQL*Plus or SQLcl:  @oracle-ddl.sql   (writes schema.sql)
-- In SQL Developer: run as script (F5) and copy the script output.
-- =============================================================================
SET LONG 2000000 LONGCHUNKSIZE 2000000 PAGESIZE 0 LINESIZE 32767 TRIMSPOOL ON FEEDBACK OFF HEADING OFF ECHO OFF VERIFY OFF

BEGIN
  DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'STORAGE', FALSE);
  DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'SEGMENT_ATTRIBUTES', FALSE);
  DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'TABLESPACE', FALSE);
  DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'SQLTERMINATOR', TRUE);
  DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'PRETTY', TRUE);
END;
/

SPOOL schema.sql

SELECT DBMS_METADATA.GET_DDL('TABLE', table_name) FROM user_tables WHERE table_name NOT LIKE 'BIN$%' ORDER BY table_name;
SELECT DBMS_METADATA.GET_DDL('VIEW', view_name) FROM user_views ORDER BY view_name;
SELECT DBMS_METADATA.GET_DEPENDENT_DDL('COMMENT', table_name) FROM user_tables t
 WHERE EXISTS (SELECT 1 FROM user_tab_comments c WHERE c.table_name = t.table_name AND c.comments IS NOT NULL)
    OR EXISTS (SELECT 1 FROM user_col_comments c WHERE c.table_name = t.table_name AND c.comments IS NOT NULL);
SELECT DBMS_METADATA.GET_DDL('INDEX', index_name) FROM user_indexes
 WHERE index_type <> 'LOB' AND generated = 'N' ORDER BY index_name;

SPOOL OFF
