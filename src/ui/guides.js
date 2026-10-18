// "Get your schema" guides: how to export a schema file from each source.
// Query text comes from /export-queries via src/generated/assets.js.

export const GUIDES = [
  {
    id: 'postgres', name: 'PostgreSQL', file: 'postgres.sql', output: 'schema.csv',
    covers: 'PostgreSQL 11+, Amazon RDS / Aurora, Supabase, Neon, Cloud SQL, Azure',
    steps: [
      'Save the query below as postgres.sql (or copy it into pgAdmin, DBeaver or DataGrip).',
      'Run it with psql and write the result as CSV, or export the result grid as CSV from your tool.',
      'Drop schema.csv into Any Schema.',
    ],
    command: 'psql "postgresql://USER@HOST:5432/DBNAME" --csv -f postgres.sql -o schema.csv',
    alternative: { label: 'Or dump the DDL (also supported)', command: 'pg_dump --schema-only --no-owner --no-privileges "postgresql://USER@HOST:5432/DBNAME" > schema.sql' },
  },
  {
    id: 'mysql', name: 'MySQL / MariaDB', file: 'mysql.sql', output: 'schema.tsv',
    covers: 'MySQL 5.7+, 8.x, MariaDB 10.2+, RDS / Aurora MySQL, PlanetScale',
    steps: [
      'Connect to the database you want to document; the query reads DATABASE().',
      'Run it in batch mode (tab-separated output) or export the result grid from MySQL Workbench as CSV.',
      'Drop schema.tsv into Any Schema.',
    ],
    command: 'mysql -h HOST -u USER -p DBNAME --batch < mysql.sql > schema.tsv',
    alternative: { label: 'Or dump the DDL', command: 'mysqldump --no-data --skip-comments -h HOST -u USER -p DBNAME > schema.sql' },
  },
  {
    id: 'sqlserver', name: 'SQL Server / Azure SQL', file: 'sqlserver.sql', output: 'schema.csv',
    covers: 'SQL Server 2012+, Azure SQL Database, Managed Instance',
    steps: [
      'Open the query in SSMS or Azure Data Studio while connected to your database.',
      'Run it, right-click the results grid and choose "Save Results As..." → CSV. Or use PowerShell below.',
      'Drop schema.csv into Any Schema. Table and column descriptions (MS_Description) are included.',
    ],
    command: 'Invoke-Sqlcmd -ServerInstance HOST -Database DBNAME -InputFile sqlserver.sql | Export-Csv schema.csv -NoTypeInformation',
    alternative: { label: 'Or script the DDL', command: 'SSMS: right-click the database → Tasks → Generate Scripts → save to schema.sql' },
  },
  {
    id: 'oracle', name: 'Oracle', file: 'oracle.sql', output: 'schema.csv',
    covers: 'Oracle 12c, 19c, 21c, 23ai, Autonomous Database',
    steps: [
      'Log in as the schema owner (or edit the WHERE clause to name another schema in upper case).',
      'In SQL Developer: run the query, right-click the results → Export → csv. In SQLcl use the commands below.',
      'Drop schema.csv into Any Schema.',
    ],
    command: 'SET SQLFORMAT csv\nSPOOL schema.csv\n@oracle.sql\nSPOOL OFF',
    alternative: { label: 'Or generate DDL with DBMS_METADATA (includes defaults)', file: 'oracle-ddl.sql', command: '@oracle-ddl.sql   -- writes schema.sql' },
  },
  {
    id: 'sqlite', name: 'SQLite', file: 'sqlite.sql', output: 'schema.csv',
    covers: 'SQLite 3.16+ (app databases, mobile, Django/Rails dev)',
    steps: [
      'The quickest route is the .schema dump below; Any Schema reads it directly.',
      'For the CSV format, run the query with the sqlite3 shell.',
    ],
    command: 'sqlite3 app.db .schema > schema.sql',
    alternative: { label: 'CSV export', command: 'sqlite3 -header -csv app.db < sqlite.sql > schema.csv' },
  },
  {
    id: 'snowflake', name: 'Snowflake', file: 'snowflake.sql', output: 'schema.sql',
    covers: 'Snowflake (any edition)',
    steps: [
      'Run GET_DDL for a schema or database in a worksheet. It includes primary and foreign keys and comments.',
      'Copy the single result cell into a file named schema.sql and drop it into Any Schema.',
      'The query below is an alternative CSV export without keys.',
    ],
    command: "SELECT GET_DDL('SCHEMA', 'MY_DB.PUBLIC', TRUE);",
  },
  {
    id: 'bigquery', name: 'BigQuery', file: 'bigquery.sql', output: 'schema.csv',
    covers: 'Google BigQuery datasets (including declared PK/FK)',
    steps: [
      'Replace `my-project.my_dataset` in the query with your dataset.',
      'Run it in the console and choose "Save results" → CSV, or use the bq CLI below.',
      'Drop schema.csv into Any Schema.',
    ],
    command: 'bq query --nouse_legacy_sql --format=csv --max_rows=100000 "$(cat bigquery.sql)" > schema.csv',
  },
  {
    id: 'salesforce', name: 'Salesforce', file: 'salesforce-export.sh', output: 'salesforce-schema.json',
    covers: 'Standard and custom objects, picklists, lookups, master-detail, formulas',
    steps: [
      'Install the Salesforce CLI and jq, then log in: sf org login web --alias my-org',
      'Run the script. With no object names it exports the common standard objects plus every custom object.',
      'Drop salesforce-schema.json into Any Schema. Windows users can run salesforce-export.ps1 instead.',
    ],
    command: './salesforce-export.sh my-org\n./salesforce-export.sh my-org Account Contact Invoice__c',
    alternative: { label: 'Windows PowerShell', file: 'salesforce-export.ps1', command: '.\\salesforce-export.ps1 -Org my-org' },
    extra: { label: 'No CLI script? Query FieldDefinition with SOQL and export CSV', file: 'salesforce-fields.soql', command: 'sf data query --query "$(cat salesforce-fields.soql)" --target-org my-org --result-format csv > salesforce-fields.csv' },
  },
  {
    id: 'mongodb', name: 'MongoDB', file: 'mongodb.js', output: 'mongo-schema.json',
    covers: 'MongoDB 4.4+ and Atlas (samples documents, reads validators and indexes)',
    steps: [
      'MongoDB has no fixed schema, so the script samples documents in each collection.',
      'Run it with mongosh. Example values are left out unless you set INCLUDE_EXAMPLES=true.',
      'Drop mongo-schema.json into Any Schema.',
    ],
    command: 'mongosh "mongodb+srv://USER@CLUSTER/DBNAME" --quiet --file mongodb.js > mongo-schema.json',
  },
  {
    id: 'other', name: 'Other databases', file: 'information-schema.sql', output: 'schema.csv',
    covers: 'Redshift, CockroachDB, YugabyteDB, Synapse, Databricks, Trino, DuckDB and anything with INFORMATION_SCHEMA',
    steps: [
      'Change the schema name in the WHERE clause and export the result grid as CSV.',
      'Keys are not part of the standard view, so Any Schema infers relationships from column names.',
      'Using an ORM? Upload its schema directly: schema.prisma, a JSON Schema or an OpenAPI file.',
    ],
    command: '-- run in your SQL client, then export the result as CSV',
  },
];
