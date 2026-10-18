# Metadata CSV format

Any Schema reads a CSV (or TSV) with **one row per column**. The export queries in
[`export-queries/`](../export-queries/) produce exactly this format, but you can also
write one by hand, export it from a data catalog, or reuse an existing data dictionary.

A file is treated as metadata (rather than data) when its header has a **table** column,
a **column-name** column, and at least one of **type**, **nullable** or **primary key**.

## Columns

Headers are matched case-insensitively, ignoring spaces, dots and underscores, so
`TABLE_NAME`, `Table Name` and `tableName` all work. Only the first three are required.

| Field | Accepted headers | Values |
|---|---|---|
| Table | `table_name`, `table`, `entity`, `object`, `sobject`, `collection`, `EntityDefinition.QualifiedApiName` | text |
| Column | `column_name`, `column`, `field`, `field_name`, `QualifiedApiName`, `attribute` (or `name` when a table column exists) | text |
| Type | `data_type`, `type`, `column_type`, `DataType` | any type text, e.g. `varchar(255)`, `NUMBER(10,2)`, `Lookup(Account)` |
| Schema | `table_schema`, `schema`, `owner`, `dataset` | text |
| Table type | `table_type`, `kind` | `TABLE`, `VIEW`, `MATERIALIZED VIEW` |
| Position | `ordinal_position`, `position`, `column_id` | number |
| Nullable | `is_nullable`, `nullable`, `IsNillable` | `YES`/`NO`, `true`/`false`, `Y`/`N`, `1`/`0` |
| Not null | `not_null`, `required`, `mandatory` | inverse of nullable |
| Default | `column_default`, `default`, `data_default` | expression |
| Primary key | `is_primary_key`, `primary_key`, `pk`, `column_key` | `YES`/`NO`, or MySQL `PRI` |
| Unique | `is_unique`, `unique` | `YES`/`NO` |
| Auto increment | `is_auto_increment`, `is_identity`, `extra` | `YES`/`NO`, or MySQL `auto_increment` |
| Indexed | `is_indexed`, `IsIndexed` | `YES`/`NO` (enables the unindexed-foreign-key check) |
| FK constraint | `fk_constraint_name`, `constraint_name` | groups the rows of a composite foreign key |
| FK target schema | `fk_ref_schema`, `referenced_table_schema` | text |
| FK target table | `fk_ref_table`, `referenced_table_name`, `references` | text |
| FK target column | `fk_ref_column`, `referenced_column_name` | text (blank = target's primary key) |
| Enum values | `enum_values`, `picklist_values`, `allowed_values` | separated by `\|` or `;` |
| Column comment | `column_comment`, `comment`, `description`, `remarks` | text |
| Table comment | `table_comment`, `table_description` | text |
| Label | `label`, `display_name` | text |
| Length / precision / scale | `length`, `character_maximum_length`, `precision`, `scale` | numbers, appended to the type when it has none |

Empty cells and the literals `NULL`, `\N` and `(null)` count as empty.

If neither a primary-key nor a foreign-key column is present, Any Schema infers keys from
column names (`id`, `<table>_id`) and does not report missing keys as problems.

## Minimal example

```csv
table_name,column_name,data_type,is_nullable,is_primary_key,fk_ref_table,column_comment
customers,id,int,NO,YES,,
customers,email,varchar(255),NO,NO,,Login email
orders,id,int,NO,YES,,
orders,customer_id,int,NO,NO,customers,
orders,total,decimal(10,2),NO,NO,,Order total incl. tax
```

## Tolerated noise

- A UTF-8 byte-order mark, `;`, tab or `|` delimiters.
- The dashed separator line `sqlcmd` prints under the header.
- Footers such as `(42 rows affected)` or `(42 rows)`.
