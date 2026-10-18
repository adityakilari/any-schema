# Any Schema

**Understand any database schema in plain English.** Drop in a SQL dump, a Prisma file, a JSON Schema, a Salesforce or MongoDB export, a column list exported from your database (for example Oracle `ALL_TAB_COLUMNS` from DBeaver), or a CSV. The schema opens as its own guide with five pages:

- **Map**: tables grouped into modules (by schema or name prefix, so 500-table schemas stay readable), a relationship map with parents on the left and children on the right, and a card for the selected table: what it stores, every column explained, its parents and children in plain sentences, with audit columns collapsed.
- **Relationships**: every relationship written out ("The staff member who is this department's manager"), grouped by parent table, with required/optional, on-delete behaviour and declared vs inferred. Includes many-to-many and polymorphic links, the most connected tables, and **"How do two tables connect?"**, which finds the join path between any two tables and writes the SQL.
- **Documentation**: how the model was built (which keys were declared, which were inferred and by which rule, which abbreviations were expanded), then each module's tables with role, purpose, keys, references and children, each expandable to full column-level documentation.
- **Review**: missing primary keys, unindexed foreign keys, money stored as floats, plain-text passwords and more, each with a fix; plus a list of columns that look like personal data.
- **Export**: `SCHEMA.md` (renders on GitHub), Mermaid, [DBML](https://dbml.dbdiagram.io/) for dbdiagram.io, and JSON.

The home page also has **ready-made export queries** for PostgreSQL, MySQL, SQL Server, Oracle, SQLite, Snowflake, BigQuery, Salesforce and MongoDB, so you can get the schema file out of your database in one step.

Everything runs in your browser. Your schema is never uploaded anywhere and never saved: reload the page and it is gone.

**Try it:** https://adityakilari.github.io/any-schema/ &nbsp;·&nbsp; [CLI](#command-line-and-ci) &nbsp;·&nbsp; [Get your schema file](#get-your-schema-file)

---

## Contents

- [What the output looks like](#what-the-output-looks-like)
- [Quick start](#quick-start)
- [Supported inputs](#supported-inputs)
- [Get your schema file](#get-your-schema-file)
  - [PostgreSQL](#postgresql) · [MySQL / MariaDB](#mysql--mariadb) · [SQL Server / Azure SQL](#sql-server--azure-sql) · [Oracle](#oracle) · [SQLite](#sqlite) · [Snowflake](#snowflake) · [BigQuery](#bigquery) · [Salesforce](#salesforce) · [MongoDB](#mongodb) · [Other databases](#other-databases) · [ORMs and API specs](#orms-and-api-specs)
- [How the analysis works](#how-the-analysis-works)
- [Command line and CI](#command-line-and-ci)
- [Optional: deeper explanation with Claude](#optional-deeper-explanation-with-claude)
- [Publish your own copy](#publish-your-own-copy)
- [Project structure](#project-structure)
- [Limitations](#limitations)
- [Contributing](#contributing) · [License](#license)

---

## What the output looks like

For the e-commerce sample (`samples/ecommerce-postgres.sql`), the overview starts like this:

> This SQL DDL (PostgreSQL) describes 11 tables and 1 view with 79 columns in total. It looks like an e-commerce data model (based on `product`, `order`, `customer` and `review`). The central tables are `customers` (referenced by 3 tables), `products` (referenced by 3 tables) and `orders` (referenced by 2 tables). There are 12 relationships: 10 declared and 2 inferred from column names, including 1 many-to-many via join tables. The review found 3 high, 9 medium and 1 low priority issues, plus 1 suggestion.

Each table gets a role and a purpose, and every column gets an explanation:

**`orders`** · Transaction. Records orders: each row is one order, identified by `id`. Each order belongs to a customer. It can optionally be linked to an address. Referenced by 2 tables: `order_items` and `payments`.

| Column | Type | Explanation |
|---|---|---|
| `customer_id` | bigint | Foreign key → `customers.id`. Links each order to the customer it belongs to; one customer can have many orders. Required: every order must have a customer. |
| `shipping_address_id` | bigint | Foreign key → `addresses.id`. Links each order to its shipping address (an address record). Optional: an order can exist without an address. |
| `status` | order_status | Current status of the order. One of: `pending`, `paid`, `shipped`, `delivered`, `cancelled`, `refunded`. Defaults to `'pending'`. |
| `total` | numeric(12,2) | Monetary amount: total of the order. Stored as an exact decimal, which is right for money. |
| `shipped_at` | timestamptz | When the order was shipped. |

A finding, with its fix:

> **HIGH** · `products.price` stores money as floating point
> double precision cannot represent values like 0.10 exactly, so totals drift by fractions of a cent. Use an exact type.
> ```sql
> ALTER TABLE public.products ALTER COLUMN price TYPE DECIMAL(12,2);
> ```

And the diagram (key columns only):

```mermaid
erDiagram
  customers {
    bigint id PK
    varchar_255 email UK
  }
  addresses {
    bigint id PK
    bigint customer_id FK
  }
  orders {
    bigint id PK
    bigint customer_id FK
    bigint shipping_address_id FK
  }
  order_items {
    bigint id PK
    bigint order_id FK
    bigint product_id FK
  }
  products {
    bigint id PK
    integer category_id FK
    varchar_64 sku UK
  }
  reviews {
    bigint id PK
    bigint product_id FK
    bigint customer_id FK
  }
  customers ||--o{ addresses : "customer_id"
  customers ||--o{ orders : "customer_id"
  addresses |o--o{ orders : "shipping_address_id"
  orders ||--o{ order_items : "order_id"
  products ||--o{ order_items : "product_id"
  products ||..o{ reviews : "product_id (inferred)"
  customers |o..o{ reviews : "customer_id (inferred)"
```

Dotted lines are relationships inferred from column names (here `reviews` has no foreign-key constraints, which is also reported as a finding).

Full generated guides: [e-commerce (PostgreSQL)](docs/examples/ecommerce-postgres.md) · [Salesforce objects](docs/examples/salesforce.md) · [clinic system from an Oracle column export](docs/examples/clinic-oracle.md).

---

## Quick start

### 1. In the browser

Open the hosted app and drop your file on the home page, or open a sample. The schema opens as its own page (`#map`); **Load another schema** or the browser's Back button returns to the home page. Nothing is stored: the schema lives only in that browser tab and is gone when you reload or close it. You can drop several files at once, for example one CSV per table; relationships between them are inferred.

The fastest route for most databases: run the query for your database from the home page in DBeaver or SQL Developer, export the result grid as JSON or CSV, and drop that file in.

### 2. Offline, one file

Download `dist/any-schema.html` from the repository (or a release) and open it. It contains the whole app. Fonts and the diagram library load from a CDN when you are online; offline, the app uses system fonts and shows the Mermaid source instead of the drawing.

### 3. Run it locally

```bash
git clone https://github.com/adityakilari/any-schema.git
cd any-schema
npm install
npm start          # http://localhost:8080
```

There is no build step for development: `index.html` loads the ES modules in `src/` directly.

### 4. Command line

```bash
npx any-schema schema.sql            # writes SCHEMA.md
```

See [Command line and CI](#command-line-and-ci).

---

## Supported inputs

| Input | Typical file | Notes |
|---|---|---|
| **SQL DDL** | `schema.sql` | `CREATE TABLE`, `CREATE VIEW`, `CREATE INDEX`, `CREATE TYPE … AS ENUM`, `ALTER TABLE … ADD CONSTRAINT`, `COMMENT ON`, inline `COMMENT`, SQL Server `sp_addextendedproperty`. Understands output from `pg_dump`, `mysqldump`, SSMS "Generate Scripts", Oracle `DBMS_METADATA.GET_DDL`, `sqlite3 .schema` and Snowflake `GET_DDL`. Dialects: PostgreSQL, MySQL/MariaDB, SQL Server, Oracle, SQLite, Snowflake, BigQuery. |
| **Metadata CSV / TSV** | `schema.csv` | One row per column, as produced by the [export queries](#get-your-schema-file), `information_schema.columns`, a Salesforce `FieldDefinition` export or a hand-made data dictionary. Column headers are matched flexibly; see [docs/metadata-csv.md](docs/metadata-csv.md). |
| **Data CSV / TSV** | `orders.csv` | A plain data extract. Types, null rates, ranges, example values and enum-like columns are inferred from up to 5,000 rows. Drop several files to see relationships between them. |
| **Prisma** | `schema.prisma` | Models, views, enums, composite types, `@relation`, `@id`/`@@id`, `@unique`, `@@index`, `@map`/`@@map`, `@db.*` native types, `///` doc comments. |
| **JSON Schema** | `*.schema.json` | `$defs`/`definitions` bundles or a single schema, `$ref`, `allOf`, `oneOf`/`anyOf`, nested objects and arrays of objects, `required`, `enum`, `format`. |
| **OpenAPI / Swagger** | `openapi.json` | `components.schemas` (OpenAPI 3) or `definitions` (Swagger 2). JSON only; convert YAML first (for example `npx js-yaml openapi.yaml > openapi.json`). |
| **Salesforce** | `salesforce-schema.json` | `sf sobject describe` output (one object or the merged array from the export script) or REST `/describe` responses. |
| **MongoDB** | `mongo-schema.json` | Output of `export-queries/mongodb.js`, or any `$jsonSchema` validator with `bsonType`. |
| **JSON column list** | `ALL_TAB_COLUMNS.json` | A catalog query exported as JSON from DBeaver, DataGrip, SQL Developer or an API: one record per column with fields like `TABLE_NAME`, `COLUMN_NAME`, `DATA_TYPE` (Oracle `ALL_TAB_COLUMNS`, `information_schema.columns`, the export queries). Same headers as the [metadata CSV](docs/metadata-csv.md). |
| **JSON table list** | `tables.json`, dbt `catalog.json` | Tables with their columns in common layouts: `{ "tables": [{ "name", "columns": [{ "name", "type", "primary_key", "references": "users.id" }] }] }`, an array of tables, a map of `table → columns`, or a dbt catalog/manifest. |
| **Sample JSON data** | `data.json` | An array of records, or `{ "customers": [...], "orders": [...] }`. JSON Lines works too. Used only when the file is not one of the layouts above; the page then says it read the file as data. |
| **Any Schema JSON** | `*.any-schema.json` | The app's own JSON export; drop it back in to reload. |

Format detection is automatic. If a file is misread, pick the format by hand in the format menu (CLI: `--input sql|prisma|json|csv`).

---

## Get your schema file

Every query below is **read-only** and returns **structure only, never row data**. The SQL exports all produce the same CSV columns, so Any Schema reads them the same way. All files are in [`export-queries/`](export-queries/), and the app's **Get your schema** tab shows the same instructions with copy buttons.

### PostgreSQL

Works on PostgreSQL 11+, Amazon RDS/Aurora, Supabase, Neon, Cloud SQL and Azure. Includes primary, unique and foreign keys, identity/serial columns, enum values, indexes and comments.

```bash
psql "postgresql://USER@HOST:5432/DBNAME" --csv -f export-queries/postgres.sql -o schema.csv
```

Or run the query in pgAdmin, DBeaver or DataGrip and export the result grid as CSV. A schema-only dump works too:

```bash
pg_dump --schema-only --no-owner --no-privileges "postgresql://USER@HOST:5432/DBNAME" > schema.sql
```

<details>
<summary><code>export-queries/postgres.sql</code></summary>

<!-- query:postgres.sql -->
```sql
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
```
<!-- /query -->
</details>

### MySQL / MariaDB

Works on MySQL 5.7+, 8.x, MariaDB 10.2+, RDS/Aurora MySQL and PlanetScale. Exports the database you are connected to.

```bash
mysql -h HOST -u USER -p DBNAME --batch < export-queries/mysql.sql > schema.tsv
```

Or export the result grid from MySQL Workbench as CSV, or dump the DDL:

```bash
mysqldump --no-data --skip-comments -h HOST -u USER -p DBNAME > schema.sql
```

<details>
<summary><code>export-queries/mysql.sql</code></summary>

<!-- query:mysql.sql -->
```sql
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
```
<!-- /query -->
</details>

### SQL Server / Azure SQL

Works on SQL Server 2012+, Azure SQL Database and Managed Instance. Includes `MS_Description` table and column descriptions.

In SSMS or Azure Data Studio: run the query, right-click the results grid, **Save Results As… → CSV**. Or with PowerShell:

```powershell
Invoke-Sqlcmd -ServerInstance HOST -Database DBNAME -InputFile export-queries\sqlserver.sql |
  Export-Csv schema.csv -NoTypeInformation
```

DDL from SSMS (**Tasks → Generate Scripts**) is also supported.

<details>
<summary><code>export-queries/sqlserver.sql</code></summary>

<!-- query:sqlserver.sql -->
```sql
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
```
<!-- /query -->
</details>

### Oracle

Works on Oracle 12c, 19c, 21c, 23ai and Autonomous Database. Exports the schema you are logged in as.

SQL Developer: run the query, right-click the results → **Export** → format `csv`. SQLcl:

```sql
SET SQLFORMAT csv
SPOOL schema.csv
@export-queries/oracle.sql
SPOOL OFF
```

Already exported `ALL_TAB_COLUMNS` (or `USER_TAB_COLUMNS`) from DBeaver or SQL Developer as JSON or CSV? Drop it in as is. That view has no key information, so keys are inferred from column names; `oracle.sql` adds the real primary and foreign keys and comments.

For full DDL with defaults, use `export-queries/oracle-ddl.sql`, which calls `DBMS_METADATA.GET_DDL` without storage clauses and writes `schema.sql`.

<details>
<summary><code>export-queries/oracle.sql</code></summary>

<!-- query:oracle.sql -->
```sql
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
```
<!-- /query -->
</details>

<details>
<summary><code>export-queries/oracle-ddl.sql</code></summary>

<!-- query:oracle-ddl.sql -->
```sql
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
```
<!-- /query -->
</details>

### SQLite

```bash
sqlite3 app.db .schema > schema.sql
# or the CSV format:
sqlite3 -header -csv app.db < export-queries/sqlite.sql > schema.csv
```

<details>
<summary><code>export-queries/sqlite.sql</code></summary>

<!-- query:sqlite.sql -->
```sql
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
```
<!-- /query -->
</details>

### Snowflake

The best export is `GET_DDL`, because it includes primary and foreign keys (Snowflake stores them without enforcing them) and comments. Run this in a worksheet and save the single result cell as `schema.sql`:

```sql
SELECT GET_DDL('SCHEMA', 'MY_DB.PUBLIC', TRUE);
```

The query file is a CSV alternative without keys.

<details>
<summary><code>export-queries/snowflake.sql</code></summary>

<!-- query:snowflake.sql -->
```sql
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
```
<!-- /query -->
</details>

### BigQuery

Replace `` `my-project.my_dataset` `` in the query, then save the results as CSV from the console, or:

```bash
bq query --nouse_legacy_sql --format=csv --max_rows=100000 "$(cat export-queries/bigquery.sql)" > schema.csv
```

<details>
<summary><code>export-queries/bigquery.sql</code></summary>

<!-- query:bigquery.sql -->
```sql
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
```
<!-- /query -->
</details>

### Salesforce

The export script uses the [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) to describe objects and writes one JSON file with fields, types, picklist values, lookups, master-detail relationships, formulas and help text.

```bash
sf org login web --alias my-org

# macOS / Linux / WSL / Git Bash (needs jq)
./export-queries/salesforce-export.sh my-org                       # common standard objects + all custom objects
./export-queries/salesforce-export.sh my-org Account Contact Invoice__c

# Windows PowerShell
.\export-queries\salesforce-export.ps1 -Org my-org
```

No CLI scripts allowed? Query `FieldDefinition` and export CSV instead (one row per field, without picklist values):

```bash
sf data query --query "$(cat export-queries/salesforce-fields.soql)" --target-org my-org --result-format csv > salesforce-fields.csv
```

You can also run that SOQL in Workbench or the Developer Console query editor (enable "Use Tooling API" if your org requires it) and export the results.

<details>
<summary><code>export-queries/salesforce-export.sh</code></summary>

<!-- query:salesforce-export.sh -->
```bash
#!/usr/bin/env bash
# =============================================================================
# Any Schema - Salesforce schema export (macOS / Linux / WSL / Git Bash)
#
# Uses the Salesforce CLI to "describe" objects and writes one JSON file that
# Any Schema reads directly (fields, types, picklists, lookups, master-detail).
#
# Requirements: Salesforce CLI (sf) logged in to your org, and jq.
#   sf org login web --alias my-org
#
# Usage:
#   ./salesforce-export.sh my-org                        # common standard objects + all custom objects
#   ./salesforce-export.sh my-org Account Contact Invoice__c
#   OUT=crm.json ./salesforce-export.sh my-org
# =============================================================================
set -eo pipefail

ORG="$1"
if [ -z "$ORG" ]; then
  echo "usage: $0 <org-alias> [Object ...]" >&2
  exit 1
fi
shift
OUT="${OUT:-salesforce-schema.json}"

command -v sf >/dev/null 2>&1 || { echo "Salesforce CLI (sf) not found: https://developer.salesforce.com/tools/salesforcecli" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "jq not found: https://jqlang.github.io/jq/download/" >&2; exit 1; }

OBJECTS=()
if [ "$#" -gt 0 ]; then
  OBJECTS=("$@")
else
  OBJECTS=(Account Contact Lead Opportunity OpportunityLineItem Product2 Case Campaign User)
  while IFS= read -r name; do
    [ -n "$name" ] && OBJECTS+=("$name")
  done < <(sf sobject list --sobject custom --target-org "$ORG" --json | jq -r '.result[]')
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

i=0
for obj in "${OBJECTS[@]}"; do
  i=$((i + 1))
  echo "[$i/${#OBJECTS[@]}] describing $obj" >&2
  if ! sf sobject describe --sobject "$obj" --target-org "$ORG" --json > "$TMP/raw.json" 2>/dev/null; then
    echo "  skipped $obj (not found or no access)" >&2
    continue
  fi
  # keep only what Any Schema uses - smaller file, no record data
  jq '.result | {
        name, label, labelPlural, custom, keyPrefix, queryable,
        fields: [ .fields[] | {
          name, label, type, length, precision, scale, nillable, unique, externalId, idLookup,
          nameField, autoNumber, calculated, calculatedFormula, defaultValue, defaultValueFormula,
          inlineHelpText, referenceTo, relationshipName, relationshipOrder, cascadeDelete,
          restrictedDelete, custom,
          picklistValues: [ .picklistValues[]? | { value, active } ]
        } ]
      }' "$TMP/raw.json" > "$TMP/$(printf '%04d' "$i").json"
done

jq -s '.' "$TMP"/[0-9]*.json > "$OUT"
echo "Wrote $OUT - drop it into Any Schema." >&2
```
<!-- /query -->
</details>

<details>
<summary><code>export-queries/salesforce-export.ps1</code></summary>

<!-- query:salesforce-export.ps1 -->
```powershell
# =============================================================================
# Any Schema - Salesforce schema export (Windows PowerShell 5.1 / PowerShell 7)
#
# Requirements: Salesforce CLI (sf) logged in to your org:
#   sf org login web --alias my-org
#
# Usage:
#   .\salesforce-export.ps1 -Org my-org
#   .\salesforce-export.ps1 -Org my-org -Objects Account,Contact,Invoice__c
#   .\salesforce-export.ps1 -Org my-org -Out crm.json
# (If scripts are blocked: powershell -ExecutionPolicy Bypass -File .\salesforce-export.ps1 -Org my-org)
# =============================================================================
param(
  [Parameter(Mandatory = $true)][string]$Org,
  [string[]]$Objects,
  [string]$Out = "salesforce-schema.json"
)
$ErrorActionPreference = "Stop"

if (-not (Get-Command sf -ErrorAction SilentlyContinue)) {
  throw "Salesforce CLI (sf) not found: https://developer.salesforce.com/tools/salesforcecli"
}

if (-not $Objects) {
  $custom = (sf sobject list --sobject custom --target-org $Org --json | Out-String | ConvertFrom-Json).result
  $Objects = @("Account", "Contact", "Lead", "Opportunity", "OpportunityLineItem", "Product2", "Case", "Campaign", "User") + @($custom)
}

$keep = "name","label","type","length","precision","scale","nillable","unique","externalId","idLookup","nameField",
        "autoNumber","calculated","calculatedFormula","defaultValue","defaultValueFormula","inlineHelpText",
        "referenceTo","relationshipName","relationshipOrder","cascadeDelete","restrictedDelete","custom"

$result = New-Object System.Collections.ArrayList
$i = 0
foreach ($obj in $Objects) {
  $i++
  Write-Host "[$i/$($Objects.Count)] describing $obj"
  try {
    $d = (sf sobject describe --sobject $obj --target-org $Org --json | Out-String | ConvertFrom-Json).result
  } catch {
    Write-Host "  skipped $obj (not found or no access)"
    continue
  }
  if (-not $d) { Write-Host "  skipped $obj"; continue }
  $fields = foreach ($f in $d.fields) {
    $o = [ordered]@{}
    foreach ($k in $keep) { $o[$k] = $f.$k }
    $o["picklistValues"] = @($f.picklistValues | ForEach-Object { [ordered]@{ value = $_.value; active = $_.active } })
    $o
  }
  [void]$result.Add([ordered]@{
    name = $d.name; label = $d.label; labelPlural = $d.labelPlural; custom = $d.custom
    keyPrefix = $d.keyPrefix; queryable = $d.queryable; fields = @($fields)
  })
}

ConvertTo-Json -InputObject @($result) -Depth 20 | Set-Content -Path $Out -Encoding UTF8
Write-Host "Wrote $Out - drop it into Any Schema."
```
<!-- /query -->
</details>

<details>
<summary><code>export-queries/salesforce-fields.soql</code></summary>

<!-- query:salesforce-fields.soql -->
```sql
SELECT EntityDefinition.QualifiedApiName, QualifiedApiName, Label, DataType, Length, Precision, Scale, IsNillable, IsIndexed, RelationshipName, Description
FROM FieldDefinition
WHERE EntityDefinition.QualifiedApiName IN ('Account', 'Contact', 'Opportunity')
ORDER BY EntityDefinition.QualifiedApiName, QualifiedApiName
```
<!-- /query -->
</details>

### MongoDB

MongoDB has no fixed schema, so the script samples documents in every collection (500 by default) and records field types, how often each field is present, `$jsonSchema` validators and indexes. Example values are **left out** unless you ask for them, because they may contain personal data.

```bash
mongosh "mongodb+srv://USER@CLUSTER/DBNAME" --quiet --file export-queries/mongodb.js > mongo-schema.json

# options
SAMPLE_SIZE=2000 INCLUDE_EXAMPLES=true mongosh "..." --quiet --file export-queries/mongodb.js > mongo-schema.json
```

<details>
<summary><code>export-queries/mongodb.js</code></summary>

<!-- query:mongodb.js -->
```js
// Any Schema - MongoDB schema export (mongosh)
// -----------------------------------------------------------------------------
// MongoDB has no fixed schema, so this script samples documents in every
// collection and writes a JSON Schema bundle (one $defs entry per collection)
// that Any Schema can read. It also includes $jsonSchema validators and indexes.
//
// Run:
//   mongosh "mongodb://USER:PASS@HOST:27017/DBNAME" --quiet --file mongodb.js > mongo-schema.json
//
// Options (environment variables):
//   SAMPLE_SIZE=500          documents sampled per collection (default 500)
//   INCLUDE_EXAMPLES=true    include up to 3 example values per field.
//                            Off by default because examples may contain personal data.
// -----------------------------------------------------------------------------

const SAMPLE_SIZE = Number((typeof process !== 'undefined' && process.env.SAMPLE_SIZE) || 500);
const INCLUDE_EXAMPLES = typeof process !== 'undefined' && /^(1|true|yes)$/i.test(process.env.INCLUDE_EXAMPLES || '');

function bsonTypeOf(v) {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return 'array';
  if (v instanceof Date) return 'date';
  const bt = v && v._bsontype;
  if (bt) {
    return ({ ObjectId: 'objectId', ObjectID: 'objectId', Decimal128: 'decimal', Long: 'long', Int32: 'int', Double: 'double',
      Binary: 'binData', UUID: 'binData', Timestamp: 'timestamp', BSONRegExp: 'regex', Code: 'javascript', MinKey: 'minKey', MaxKey: 'maxKey' })[bt] || String(bt).toLowerCase();
  }
  switch (typeof v) {
    case 'string': return 'string';
    case 'boolean': return 'bool';
    case 'number': return Number.isInteger(v) ? 'int' : 'double';
    case 'bigint': return 'long';
    case 'object': return 'object';
    default: return 'string';
  }
}

// Collect stats for every field path, recursing into sub-documents and arrays.
function newNode() { return { count: 0, types: {}, props: {}, items: null, examples: [] }; }

function visit(node, value) {
  node.count++;
  const t = bsonTypeOf(value);
  node.types[t] = (node.types[t] || 0) + 1;
  if (t === 'object') {
    for (const [k, v] of Object.entries(value)) {
      node.props[k] = node.props[k] || newNode();
      visit(node.props[k], v);
    }
  } else if (t === 'array') {
    node.items = node.items || newNode();
    for (const el of value.slice(0, 50)) visit(node.items, el);
  } else if (INCLUDE_EXAMPLES && t !== 'null' && node.examples.length < 3) {
    const s = String(value).slice(0, 60);
    if (!node.examples.includes(s)) node.examples.push(s);
  }
}

function toSchema(node, parentCount) {
  const types = Object.keys(node.types);
  const out = { bsonType: types.length === 1 ? types[0] : types };
  if (parentCount) out['x-presence'] = Math.round((node.count / parentCount) * 1000) / 1000;
  if (node.examples.length) out['x-examples'] = node.examples;
  if (node.types.object) {
    const objCount = node.types.object;
    out.properties = {};
    const required = [];
    for (const [k, child] of Object.entries(node.props)) {
      out.properties[k] = toSchema(child, objCount);
      if (child.count === objCount && !child.types.null) required.push(k);
    }
    if (required.length) out.required = required;
  }
  if (node.items) out.items = toSchema(node.items, 0);
  return out;
}

const result = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: db.getName(),
  description: `MongoDB database ${db.getName()} sampled on ${new Date().toISOString()} (up to ${SAMPLE_SIZE} documents per collection).`,
  'x-source': 'mongodb',
  $defs: {},
};

for (const info of db.getCollectionInfos({ type: 'collection' })) {
  const name = info.name;
  if (name.startsWith('system.')) continue;
  const coll = db.getCollection(name);
  const docs = coll.aggregate([{ $sample: { size: SAMPLE_SIZE } }], { allowDiskUse: true }).toArray();
  const root = newNode();
  for (const d of docs) visit(root, d);
  const schema = docs.length ? toSchema(root, 0) : { bsonType: 'object', properties: {} };
  const validator = info.options && info.options.validator && info.options.validator.$jsonSchema;
  if (validator) {
    // declared validator wins for types/required; keep sampled presence where available
    schema['x-validator'] = true;
    for (const [k, v] of Object.entries(validator.properties || {})) {
      schema.properties = schema.properties || {};
      schema.properties[k] = { ...(schema.properties[k] || {}), ...v };
    }
    if (validator.required) schema.required = validator.required;
    if (validator.description) schema.description = validator.description;
  }
  schema['x-collection'] = true;
  schema['x-document-count'] = coll.estimatedDocumentCount();
  schema['x-sampled'] = docs.length;
  schema['x-indexes'] = coll.getIndexes().map((ix) => ({ name: ix.name, key: ix.key, unique: !!ix.unique }));
  result.$defs[name] = schema;
}

print(JSON.stringify(result, null, 2));
```
<!-- /query -->
</details>

### Other databases

Redshift, CockroachDB, YugabyteDB, Azure Synapse, Databricks SQL, Trino, DuckDB and most other databases implement the standard `INFORMATION_SCHEMA`. The generic query returns tables, columns, types, nullability and defaults. Keys are not part of that view, so Any Schema infers relationships from column names and does not report missing keys as errors.

<details>
<summary><code>export-queries/information-schema.sql</code></summary>

<!-- query:information-schema.sql -->
```sql
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
```
<!-- /query -->
</details>

### ORMs and API specs

| Tool | What to upload |
|---|---|
| Prisma | `prisma/schema.prisma` as is |
| Django | `python manage.py sqlmigrate app 0001` output, or a `pg_dump --schema-only` of the dev database |
| Rails | `db/structure.sql` (`config.active_record.schema_format = :sql`) or a schema-only dump |
| Laravel | `php artisan schema:dump` (writes `database/schema/*.sql`) |
| TypeORM / Sequelize / Hibernate / EF Core | A schema-only dump of the database they created |
| OpenAPI / Swagger | The spec as JSON |
| Zod / TypeBox / Pydantic | Export a JSON Schema (`zod-to-json-schema`, `Model.model_json_schema()`) |

---

## How the analysis works

Everything is rule-based and deterministic, so the same input always gives the same output, and it works offline.

1. **Parse** the input into one common model: tables, columns, types, keys, indexes, enums and comments. Each parser lives in [`src/core/parsers/`](src/core/parsers/).
2. **Relationships**
   - *Declared*: foreign keys, Prisma `@relation`, Salesforce lookups and master-detail, JSON Schema `$ref` (embedded).
   - *Inferred* from names, and marked as such: `customer_id` → `customers`, `customerId` → `customer`, a column named like another table's primary key (`CustomerID`), role prefixes (`RSPBL_SM_ID` → `SM`, `ATTND_PRV_ID` → `PRV`), `parent_id` → same table, `manager_id`/`created_by` → a users or employees table, and `authorIds` arrays → many-to-many. When the file has no constraints at all (a plain column export), primary keys are inferred too: `ID`, `<TABLE>_ID`, or a NOT NULL first column ending in `_ID`.
   - *One-to-one* when the foreign key is unique or is the primary key; *many-to-many* through join tables.
3. **Table roles**: core entity, entity, transaction, line items, join table, lookup, log/history, configuration, view or embedded document. The role drives the purpose sentence for each table.
4. **Modules**: schemas with more than 24 tables are grouped by schema (when there are several) or by table-name prefix (`ENC_*`, `BILL_*`), with the rest under "Other tables". Salesforce splits into standard and custom objects.
5. **Abbreviations** common in enterprise naming are expanded in explanations, so `LIC_EXPR_DT` reads as "license expiration date" and `MGR_SM_ID` as "the staff member who is this department's manager". The list lives in `ABBREVIATIONS` in [`src/core/model.js`](src/core/model.js); add your organisation's own abbreviations there. `INS` is read as "inserted" before a timestamp or user column (`ROW_INS_TMSP`) and as "insurance" elsewhere.
6. **Audit columns** (`created_at`, `ROW_INS_TMSP`, `ROW_UID`, `LAST_UPD_BY`…) are recognised and collapsed in the table card. **Polymorphic links** (`ENT_ID` next to `ENT_TYPE_CD`) are flagged instead of drawn, because their target table changes per row.
7. **Column explanations** combine dozens of naming patterns (audit timestamps, soft deletes, flags, money, status, codes, addresses, secrets, counters and more) with the column's type, constraints, defaults, enum values, computed expressions and source comments. Comments from the source always appear next to the generated text.
8. **Findings**

   | Rule | Severity |
   |---|---|
   | Table without a primary key | high |
   | Money stored as floating point | high |
   | Column named `password` that may hold plain text | high |
   | Foreign key without an index (PostgreSQL, Oracle, SQL Server; MySQL indexes them automatically) | medium |
   | Column that looks like a foreign key but has no constraint | medium |
   | Mixed value types or money stored as text (data CSVs) | medium |
   | Timestamps without time zone (PostgreSQL) | low |
   | Mixed `snake_case`/`camelCase`, mixed singular/plural table names, reserved words, very wide tables | low |
   | JSON in text columns, free-text status columns, missing audit timestamps, unconnected tables | info |

   Fixes are written for the detected dialect (PostgreSQL, MySQL, SQL Server, Oracle) or for Prisma (`@@index`, `@db.Timestamptz`).
9. **Privacy scan**: column names are matched against categories (government IDs, payment cards, bank accounts, credentials, health, special categories, date of birth, contact details, addresses, names, compensation, location, online identifiers) with a sensitivity level.

---

## Command line and CI

```text
any-schema <file...> [options]

  -o, --out <file>       Output file (default SCHEMA.md for markdown, stdout otherwise)
  -f, --format <name>    md (default), mermaid, dbml, json, summary
      --input <format>   Force input format: sql, prisma, json, csv
      --title <text>     Title for the Markdown guide
      --fail-on <level>  Exit with code 1 if a finding of this level or worse exists
      --stdout           Print Markdown to stdout
```

Examples:

```bash
npx any-schema prisma/schema.prisma -o docs/DATABASE.md
npx any-schema customers.csv orders.csv -f summary
pg_dump --schema-only mydb | npx any-schema - -f dbml > schema.dbml
npx any-schema schema.sql -f summary --fail-on high     # CI gate
```

### Keep schema docs up to date with GitHub Actions

This workflow regenerates `docs/DATABASE.md` whenever migrations change, and fails the build if a high-severity problem appears:

```yaml
name: Schema docs
on:
  push:
    paths: ['prisma/schema.prisma']
jobs:
  docs:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npx -y any-schema prisma/schema.prisma -o docs/DATABASE.md --fail-on high
      - run: |
          git config user.name "github-actions"
          git config user.email "github-actions@users.noreply.github.com"
          git add docs/DATABASE.md
          git diff --cached --quiet || git commit -m "docs: update database guide"
          git push
```

Until the package is published to npm, use `npx -y github:adityakilari/any-schema` instead of `npx -y any-schema`.

---

## Optional: deeper explanation with Claude

The Overview tab has an optional **Explain this schema** button that sends a compact description of the schema (table and column names, types, relationships and findings, no data rows) to the [Claude API](https://docs.claude.com/en/api/overview) using **your own API key**. It returns a narrative onboarding guide: what the system does, the main flow, example queries, and questions to ask the team.

- The key stays in your browser. It is kept for the current tab only if you tick "Remember".
- Nothing is sent unless you click the button. All other features work without a key or network access.

---

## Publish your own copy

1. Fork this repository, or create a new one and push this project to it.
2. Replace `adityakilari` with your own GitHub user name in `README.md`, `index.html`, `package.json` and `src/core/render.js` (`HOMEPAGE`).
3. In **Settings → Pages**, set **Source** to **GitHub Actions**. The `pages.yml` workflow tests, builds and deploys on every push to `main`.
4. Optional: `npm publish` to make `npx any-schema` available.

---

## Project structure

```text
any-schema/
├── index.html                 the app (loads src/ui/app.js as an ES module)
├── src/
│   ├── core/                  no DOM: shared by the browser app and the CLI
│   │   ├── model.js           common schema model, type categories, naming helpers
│   │   ├── parse.js           format detection
│   │   ├── parsers/           sql.js, prisma.js, json.js, csv.js
│   │   ├── infer.js           type and statistics inference from data rows
│   │   ├── analyze.js         relationships, roles, explanations, findings, privacy, summary
│   │   ├── modules.js         groups large schemas into modules
│   │   ├── paths.js           join path between two tables, with SQL
│   │   └── render.js          Mermaid, Markdown, DBML, JSON
│   ├── ui/                    app.js, guides.js, styles.css
│   └── generated/assets.js    export queries + samples embedded for the browser (npm run generate)
├── export-queries/            read-only export queries and scripts per database
├── samples/                   example inputs for every format (also used by the tests)
├── bin/any-schema.js          CLI
├── scripts/                   generate.mjs, build.mjs (single-file dist), serve.mjs
├── test/                      node:test suites, including export queries run on real PostgreSQL and SQLite
├── dist/any-schema.html       self-contained offline build
└── docs/metadata-csv.md       the CSV format the export queries produce
```

Commands:

```bash
npm start          # dev server
npm test           # all tests
npm run generate   # refresh src/generated/assets.js and the queries in this README
npm run build      # generate + dist/any-schema.html
```

---

## Limitations

- Explanations come from names, types and constraints. They are a strong first draft, not ground truth; a column called `status2` stays vague. Add comments in your database (`COMMENT ON`, `MS_Description`, Salesforce help text) and they will appear alongside.
- The SQL parser is tolerant, not a full grammar. Stored procedures, triggers and functions are skipped. If a dialect-specific clause is misread, please [open an issue](https://github.com/adityakilari/any-schema/issues) with a small example.
- MySQL, SQL Server, Oracle, Snowflake and BigQuery queries are written against each vendor's documented catalog views. PostgreSQL and SQLite queries are additionally run against real engines in the test suite.
- Large schemas work well: a 518-table, 4,900-column export opens in under half a second. The map shows one module at a time; very large modules wrap into several columns.

---

## Contributing

Contributions are welcome, especially new naming patterns, findings, dialect fixes and export queries. See [CONTRIBUTING.md](CONTRIBUTING.md). Every new rule should come with a sample or a test.

## License

[MIT](LICENSE)
