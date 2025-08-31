/**
 * SQL tool
 *
 * {
 *   "provider": "local",
 *   "type": "sql",
 *   "database_label": "my_database",
 *   "driver": "postgres",
 *   "host": "localhost",
 *   "username": "my_user",
 * }
 *
 * This tool inherits from the base SQL tool. It makes tools based on SQL queries.
 * Instead of accepting a raw SQL query, it accepts parameters.
 *
 * Functions has access to the context object internally. References to the context object such as
 * the organization address could be expressed as "$context.conversation.organization_address" in the SQL query.
 *
 * {
 *   "database_label": "my_database", // DB config to use
 *   "name": "get_user_by_organization_address",
 *   "description": "Get a user by organization address",
 *   "input": {
 *     "type": "object",
 *     "properties": {
 *       "name": {
 *         "type": "string",
 *         "description": "The name of the user"
 *       }
 *     },
 *     "required": ["name"]
 *   }, // Will be used as JSON schema for the tool input.
 *   "query": "
 *     SELECT * FROM users
 *     WHERE organization_address = '$context.conversation.organization_address'
 *     AND name = '$input.name'
 *   "
 * }
 */

import * as z from "zod";
import postgres from "postgres";
import mysql from "mysql2";
import * as libsql from "@libsql/client";
import type { RequestContext } from "../protocols/base.ts";
import type { LocalSQLToolConfig } from "../../_shared/supabase.ts";
import type { ToolDefinition } from "./base.ts";

// Type definitions
type Driver = "postgres" | "mysql" | "libsql";

type DBSchema = {
  enums?: EnumDef[]; // PostgreSQL only
  tables: TableDef[];
};

type EnumDef = {
  schema: string;
  name: string;
  values: string[];
};

type TableDef = {
  schema: string;
  name: string;
  type: string;
  columns: ColumnDef[];
  constraints: ConstraintDef[];
  comment?: string;
};

type ColumnDef = {
  name: string;
  type: string; // use udt_name
  nullable: boolean;
  default?: string;
  comment?: string;
};

type ConstraintDef = UniqueConstraintDef | ForeignKeyConstraintDef;

type UniqueConstraintDef = {
  schema: string;
  name: string;
  type: "PRIMARY KEY" | "UNIQUE";
  columns: string[]; // sorted by ordinal_position
};

type ForeignKeyConstraintDef = {
  schema: string;
  name: string;
  type: "FOREIGN KEY";
  columns: string[]; // sorted by ordinal_position
  referenced_table: {
    schema: string;
    name: string;
    columns: string[]; // sorted by position_in_unique_constraint
  };
  referenced_constraint: {
    schema: string;
    name: string;
  };
};

// Schema definitions

export const LibSQLConfigSchema = z.object({
  driver: z.literal("libsql"),
  url: z.string(),
  token: z.string().optional(),
});
type LibSQLConfig = z.infer<typeof LibSQLConfigSchema>;

export const SQLConfigSchema = z.object({
  driver: z.union([z.literal("postgres"), z.literal("mysql")]),
  host: z.string(),
  port: z.number().optional(),
  user: z.string().optional(),
  password: z.string().optional(),
  database: z.string().optional(),
});
type SQLConfig = z.infer<typeof SQLConfigSchema>;

export type SQLToolConfig = LibSQLConfig | SQLConfig;

export const GetDbSchemaInputSchema = z.object({
  schemas: z
    .array(z.string())
    .optional()
    .describe("Optional: schema names to include."),
});

export const GetDbSchemaOutputSchema = z.object({
  enums: z
    .array(
      z.object({
        schema: z.string(),
        name: z.string(),
        values: z.array(z.string()),
      })
    )
    .optional(),
  tables: z.array(
    z.object({
      schema: z.string(),
      name: z.string(),
      type: z.string(),
      columns: z.array(
        z.object({
          name: z.string(),
          type: z.string(),
          nullable: z.boolean(),
          default: z.string().optional(),
          comment: z.string().optional(),
        })
      ),
      constraints: z.array(
        z.union([
          z.object({
            schema: z.string(),
            name: z.string(),
            type: z.union([z.literal("PRIMARY KEY"), z.literal("UNIQUE")]),
            columns: z.array(z.string()),
          }),
          z.object({
            schema: z.string(),
            name: z.string(),
            type: z.literal("FOREIGN KEY"),
            columns: z.array(z.string()),
            referenced_table: z.object({
              schema: z.string(),
              name: z.string(),
              columns: z.array(z.string()),
            }),
            referenced_constraint: z.object({
              schema: z.string(),
              name: z.string(),
            }),
          }),
        ])
      ),
      comment: z.string().optional(),
    })
  ),
});

export const ExecuteSqlInputSchema = z.object({
  query: z.string().describe("The SQL query to execute"),
});

export const ExecuteSqlOutputSchema = z.array(z.record(z.string(), z.any()));

// Query builders

type TableRow = {
  schema: string;
  name: string;
  type: string;
};

function getTablesQuery(quotedSchemas: string) {
  return `
    SELECT 
      t.table_schema AS schema,
      t.table_name AS name,
      t.table_type AS type
    FROM information_schema.tables t
    WHERE t.table_schema IN (${quotedSchemas})
    ORDER BY t.table_schema, t.table_name;
  `;
}

type ColumnRow = {
  table_schema: string;
  table_name: string;
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
};

function getColumnsQuery(quotedSchemas: string, driver: Driver) {
  let typeColumn = "";

  if (driver === "postgres") {
    typeColumn = "udt_name";
  } else if (driver === "mysql") {
    typeColumn = "column_type";
  }

  return `
    SELECT 
      c.table_schema,
      c.table_name,
      c.column_name AS name,
      c.${typeColumn} AS type,
      c.is_nullable = 'YES' AS nullable,
      c.column_default AS \`default\`
    FROM information_schema.columns c
    WHERE c.table_schema IN (${quotedSchemas})
    ORDER BY c.table_schema, c.table_name, c.ordinal_position;
  `;
}

type ConstraintRow =
  | {
      table_schema: string;
      table_name: string;
      schema: string;
      name: string;
      type: "PRIMARY KEY" | "UNIQUE";
      column_name: string;
      column_ordinal_position: number;
    }
  | {
      table_schema: string;
      table_name: string;
      schema: string;
      name: string;
      type: "FOREIGN KEY";
      column_name: string;
      column_ordinal_position: number;
      referenced_constraint_schema: string;
      referenced_constraint_name: string;
      referenced_table_schema: string;
      referenced_table_name: string;
      referenced_column_name: string;
    };

function getPostgresConstraintsQuery(quotedSchemas: string) {
  return `
    SELECT 
      tc.table_schema,
      tc.table_name,
      tc.constraint_schema AS schema,
      tc.constraint_name   AS name,
      tc.constraint_type   AS type,
      kcu.column_name,
      kcu.ordinal_position AS column_ordinal_position,
      rc.unique_constraint_schema AS referenced_constraint_schema,
      rc.unique_constraint_name   AS referenced_constraint_name,
      ccu.table_schema AS referenced_table_schema,
      ccu.table_name   AS referenced_table_name,
      ccu.column_name  AS referenced_column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu 
      ON tc.constraint_schema = kcu.constraint_schema
     AND tc.constraint_name   = kcu.constraint_name
    LEFT JOIN information_schema.referential_constraints rc
      ON tc.constraint_schema = rc.constraint_schema
     AND tc.constraint_name   = rc.constraint_name
    LEFT JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_schema = ccu.constraint_schema
     AND tc.constraint_name   = ccu.constraint_name
    WHERE tc.table_schema IN (${quotedSchemas})
      AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE', 'FOREIGN KEY')
    ORDER BY 
      tc.table_schema,
      tc.table_name,
      tc.constraint_schema,
      tc.constraint_name,
      kcu.ordinal_position;
  `;
}

function getMySQLConstraintsQuery(quotedSchemas: string) {
  return `
    SELECT 
      tc.table_schema,
      tc.table_name,
      tc.constraint_schema AS schema,
      tc.constraint_name   AS name,
      tc.constraint_type   AS type,
      kcu.column_name,
      kcu.ordinal_position AS column_ordinal_position,
      rc.unique_constraint_schema AS referenced_constraint_schema,
      rc.unique_constraint_name   AS referenced_constraint_name,
      kcu.referenced_table_schema,
      kcu.referenced_table_name,
      kcu.referenced_column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu 
      ON tc.constraint_name = kcu.constraint_name
     AND tc.table_name      = kcu.table_name
    LEFT JOIN information_schema.referential_constraints rc
      ON tc.constraint_name = rc.constraint_name
     AND tc.table_name      = rc.table_name
    WHERE tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE', 'FOREIGN KEY')
    ORDER BY 
      tc.table_schema,
      tc.table_name,
      tc.constraint_schema,
      tc.constraint_name,
      kcu.ordinal_position;
  `;
}

type TableCommentRow = {
  schema: string;
  name: string;
  comment: string;
};

function getPostgresTableCommentsQuery(quotedSchemas: string) {
  return `
      SELECT 
        n.nspname AS schema,
        c.relname AS name,
        d.description AS comment
      FROM pg_class c
      JOIN pg_namespace n
        ON n.oid = c.relnamespace
      LEFT JOIN pg_description d
        ON d.objoid = c.oid
       AND d.classoid = 'pg_class'::regclass
      WHERE c.relkind = 'r' AND n.nspname IN (${quotedSchemas})
        AND d.description IS NOT NULL
      ORDER BY n.nspname, c.relname;
    `;
}

function getMySQLTableCommentsQuery(quotedSchemas: string) {
  return `
      SELECT 
        t.table_schema AS schema,
        t.table_name AS name,
        t.table_comment AS comment
      FROM information_schema.tables t
      WHERE t.table_comment IS NOT NULL
      ORDER BY t.table_schema, t.table_name;
    `;
}

type ColumnCommentRow = {
  table_schema: string;
  table_name: string;
  name: string;
  comment: string;
};

function getPostgresColumnCommentsQuery(quotedSchemas: string) {
  return `
      SELECT 
        n.nspname AS table_schema,
        c.relname AS table_name,
        a.attname AS name,
        d.description AS comment
      FROM pg_attribute a
      JOIN pg_class c
        ON c.oid = a.attrelid
      JOIN pg_namespace n
        ON n.oid = c.relnamespace
      LEFT JOIN pg_description d
        ON d.objoid = a.attrelid
       AND d.objsubid = a.attnum
      WHERE a.attnum > 0
        AND NOT a.attisdropped
        AND n.nspname IN (${quotedSchemas})
        AND d.description IS NOT NULL
      ORDER BY n.nspname, c.relname, a.attnum;
    `;
}

function getMySQLColumnCommentsQuery(quotedSchemas: string) {
  return `
      SELECT 
        c.table_schema,
        c.table_name,
        c.column_name AS name,
        c.column_comment AS comment
      FROM information_schema.columns c
      WHERE c.column_comment IS NOT NULL
      ORDER BY c.table_schema, c.table_name, c.ordinal_position;
    `;
}

type EnumRow = {
  schema: string;
  name: string;
  values: string[];
};

function getPostgresEnumsQuery(quotedSchemas: string) {
  return `
      SELECT 
        n.nspname AS schema,
        t.typname AS name,
        array_agg(e.enumlabel ORDER BY e.enumsortorder) AS values
      FROM pg_type t
      JOIN pg_enum e
        ON t.oid = e.enumtypid
      JOIN pg_namespace n
        ON n.oid = t.typnamespace
      WHERE n.nspname IN (${quotedSchemas})
      GROUP BY n.nspname, t.typname
      ORDER BY n.nspname, t.typname;
    `;
}

// Database client

class BaseClient {
  driver: Driver;
  quotedSchemas: string = "";

  private getQuotedSchemas(schemas: string[]): string {
    return schemas.map((s) => `'${s.replace(/'/g, "''")}'`).join(", ");
  }

  setSchemas(schemas?: string[]) {
    if (this.driver === "postgres") {
      if (!schemas || schemas.length === 0) {
        schemas = ["public"];
      }

      this.quotedSchemas = this.getQuotedSchemas(schemas!);
    } else if (this.driver === "mysql") {
      this.quotedSchemas = "DATABASE()";
    }
  }

  constructor(config: LocalSQLToolConfig["config"]) {
    this.driver = config.driver;

    this.setSchemas();
  }

  async execute<T = unknown>(query: string): Promise<T[]> {
    throw new Error("Not implemented");
  }

  async close(): Promise<void> {
    throw new Error("Not implemented");
  }

  async tables() {
    return await this.execute<TableRow>(getTablesQuery(this.quotedSchemas));
  }

  async columns() {
    return await this.execute<ColumnRow>(
      getColumnsQuery(this.quotedSchemas, this.driver!)
    );
  }

  async constraints(): Promise<ConstraintRow[]> {
    throw new Error("Not implemented");
  }

  async tableComments(): Promise<TableCommentRow[]> {
    throw new Error("Not implemented");
  }

  async columnComments(): Promise<ColumnCommentRow[]> {
    throw new Error("Not implemented");
  }

  async enums(): Promise<EnumRow[]> {
    throw new Error("Not implemented");
  }
}

// Postgres client implementation

class PostgresClient extends BaseClient {
  private conn: postgres.Sql;

  constructor(config: SQLConfig) {
    super(config);

    const connectionConfig = {
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
    };
    this.conn = postgres(connectionConfig);
  }

  override async execute<T = unknown>(query: string): Promise<T[]> {
    return await this.conn.unsafe(query);
  }

  override async close() {
    return await this.conn.end();
  }

  override async constraints(): Promise<ConstraintRow[]> {
    return await this.execute<ConstraintRow>(
      getPostgresConstraintsQuery(this.quotedSchemas)
    );
  }

  override async tableComments(): Promise<TableCommentRow[]> {
    return await this.execute<TableCommentRow>(
      getPostgresTableCommentsQuery(this.quotedSchemas)
    );
  }

  override async columnComments(): Promise<ColumnCommentRow[]> {
    return await this.execute<ColumnCommentRow>(
      getPostgresColumnCommentsQuery(this.quotedSchemas)
    );
  }

  override async enums(): Promise<EnumRow[]> {
    return await this.execute<EnumRow>(
      getPostgresEnumsQuery(this.quotedSchemas)
    );
  }
}

// MySQL client implementation

class MySQLClient extends BaseClient {
  private conn: Promise<mysql.Connection>;

  constructor(config: SQLConfig) {
    super(config);

    this.conn = mysql.createConnection({
      host: config.host,
      port: config.port,
      user: config.user,
      database: config.database,
      password: config.password,
    });
  }

  override async execute<T = unknown>(query: string): Promise<T[]> {
    // @ts-ignore Connection does have a query method
    const [results, _fields] = await (await this.conn).query(query);
    return results as T[];
  }

  override async close() {
    return await (await this.conn).end();
  }

  override async constraints(): Promise<ConstraintRow[]> {
    return await this.execute<ConstraintRow>(
      getMySQLConstraintsQuery(this.quotedSchemas)
    );
  }

  override async tableComments(): Promise<TableCommentRow[]> {
    return await this.execute<TableCommentRow>(
      getMySQLTableCommentsQuery(this.quotedSchemas)
    );
  }

  override async columnComments(): Promise<ColumnCommentRow[]> {
    return await this.execute<ColumnCommentRow>(
      getMySQLColumnCommentsQuery(this.quotedSchemas)
    );
  }

  override async enums(): Promise<EnumRow[]> {
    return [];
  }
}

// LibSQL client implementation

class LibSQLClient extends BaseClient {
  private conn: libsql.Client;

  constructor(config: LibSQLConfig) {
    super(config);

    this.conn = libsql.createClient({
      url: config.url,
      authToken: config.token,
    });
  }

  override async execute<T = unknown>(query: string): Promise<T[]> {
    const result = await this.conn.execute(query);
    return result.rows as T[];
  }

  override async close() {
    return await this.conn.close();
  }

  override async tables() {
    return await this.execute<TableRow>(`
      SELECT schema, name, type
      FROM pragma_table_list
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY schema, name;
    `);
  }

  override async columns() {
    return await this.execute<ColumnRow>(`
      SELECT
        t.schema AS table_schema,
        t.name AS table_name,
        ti.name AS name,
        ti.type AS type,
        NOT(ti."notnull") as nullable,
        ti.dflt_value AS "default"
      FROM pragma_table_list AS t
      JOIN pragma_table_info(t.name, t.schema) AS ti
        ON 1
      WHERE t.name NOT LIKE 'sqlite_%'
      ORDER BY t.schema, t.name, ti.cid;
    `);
  }

  override async constraints() {
    const pk_and_unique = await this.execute<ConstraintRow>(`
      SELECT
        t.schema AS table_schema,
        t.name AS table_name,
        t.schema AS schema,
        il.name,
        CASE il.origin WHEN 'pk' THEN 'PRIMARY KEY' ELSE 'UNIQUE' END AS type,
        CASE ii.cid WHEN -1 THEN '(rowid)' ELSE ii.name END AS column_name,
        ii.seqno + 1 AS column_ordinal_position -- keep 1-indexed based on the SQL standard
      FROM pragma_table_list AS t
      JOIN pragma_index_list(t.name, t.schema) AS il
        ON 1
      LEFT JOIN pragma_index_info(il.name, t.schema) AS ii
        ON 1
      WHERE t.name NOT LIKE 'sqlite_%'
        AND il."unique" -- avoid partial indexes
        AND ii.cid >= -1 -- accept columns (>=0) and rowid (-1) but reject expression (-2)
      ORDER BY t.schema, t.name, il.name, ii.seqno;
    `);

    const fk = await this.execute<ConstraintRow>(`
      SELECT
        t.schema AS table_schema,
        t.name AS table_name,
        t.schema AS schema,
        CONCAT('fk', '_', t.name, '_', fk.id) AS name,
        "FOREIGN KEY" AS type,
        fk."from" AS column_name,
        fk.seq + 1 AS column_ordinal_position,
        t.schema AS referenced_constraint_schema,
        '' AS referenced_constraint_name,
        t.schema AS referenced_table_schema,
        fk."table" AS referenced_table_name,
        fk."to" AS referenced_column_name
      FROM pragma_table_list AS t
      JOIN pragma_foreign_key_list(t.name, t.schema) AS fk
        ON 1
      WHERE t.name NOT LIKE 'sqlite_%'
      ORDER BY t.schema, t.name, 4, fk.seq
    `);

    return [...pk_and_unique, ...fk];
  }

  override async tableComments(): Promise<TableCommentRow[]> {
    return [];
  }

  override async columnComments(): Promise<ColumnCommentRow[]> {
    return [];
  }

  override async enums(): Promise<EnumRow[]> {
    return [];
  }
}

// Factory function to create the appropriate client

function createDBClient(config: SQLToolConfig): BaseClient {
  switch (config.driver) {
    case "postgres":
      return new PostgresClient(config);
    case "mysql":
      return new MySQLClient(config);
    case "libsql":
      return new LibSQLClient(config);
    default:
      // @ts-ignore type never
      throw new Error(`Unsupported SQL driver: ${config.driver}`);
  }
}

async function getDbSchema(client: BaseClient): Promise<DBSchema> {
  // Fetch all pieces in parallel
  const [
    tableRows,
    columnRows,
    constraintRows,
    tableCommentRows,
    columnCommentRows,
    enumRows,
  ] = await Promise.all([
    client.tables(),
    client.columns(),
    client.constraints(),
    client.tableComments(),
    client.columnComments(),
    client.enums(),
  ]);

  // -----------------------------------------------------------------------
  //  Tables
  // -----------------------------------------------------------------------

  // Map to store table definitions keyed by "schema.name"
  const tableMap = new Map<string, TableDef>();

  // Pre-populate tables map
  for (const t of tableRows) {
    const key = `${t.schema}.${t.name}`;
    tableMap.set(key, {
      schema: t.schema,
      name: t.name,
      type: t.type,
      columns: [],
      constraints: [],
      comment: undefined,
    });
  }

  // -----------------------------------------------------------------------
  //  Table & column comments
  // -----------------------------------------------------------------------

  // Table comments
  for (const tc of tableCommentRows) {
    const key = `${tc.schema}.${tc.name}`;
    const table = tableMap.get(key);

    if (table && tc.comment) {
      table.comment = tc.comment;
    }
  }

  // Build a quick lookup map for column comments
  const columnCommentMap = new Map<string, string>();
  for (const cc of columnCommentRows) {
    columnCommentMap.set(
      `${cc.table_schema}.${cc.table_name}.${cc.name}`,
      cc.comment
    );
  }

  // -----------------------------------------------------------------------
  //  Columns
  // -----------------------------------------------------------------------

  for (const c of columnRows) {
    const tableKey = `${c.table_schema}.${c.table_name}`;
    const table = tableMap.get(tableKey);
    if (!table) continue; // should not happen but just in case

    const comment = columnCommentMap.get(
      `${c.table_schema}.${c.table_name}.${c.name}`
    );

    table.columns.push({
      name: c.name,
      type: c.type,
      nullable: Boolean(c.nullable),
      ...(c.default && { default: c.default }),
      ...(comment && { comment }),
    });
  }

  // -----------------------------------------------------------------------
  //  Constraints
  // -----------------------------------------------------------------------

  const constraintMap = new Map<string, ConstraintDef>();

  for (const constraintColumn of constraintRows) {
    const key = [
      constraintColumn.table_schema,
      constraintColumn.table_name,
      constraintColumn.schema,
      constraintColumn.name,
    ].join(".");

    let constraint = constraintMap.get(key);

    if (!constraint) {
      if (constraintColumn.type === "FOREIGN KEY") {
        constraint = {
          schema: constraintColumn.schema,
          name: constraintColumn.name,
          type: "FOREIGN KEY",
          columns: [],
          referenced_constraint: {
            schema: constraintColumn.referenced_constraint_schema,
            name: constraintColumn.referenced_constraint_name,
          },
          referenced_table: {
            schema: constraintColumn.referenced_table_schema,
            name: constraintColumn.referenced_table_name,
            columns: [],
          },
        };
      } else {
        constraint = {
          schema: constraintColumn.schema,
          name: constraintColumn.name,
          type: constraintColumn.type as "PRIMARY KEY" | "UNIQUE",
          columns: [],
        };
      }

      constraintMap.set(key, constraint);

      const tableKey = `${constraintColumn.table_schema}.${constraintColumn.table_name}`;
      const table = tableMap.get(tableKey);
      if (!table) continue; // should not happen but just in case

      table.constraints.push(constraint);
    }

    constraint.columns.push(constraintColumn.column_name);

    if (
      constraint.type === "FOREIGN KEY" &&
      constraintColumn.type === "FOREIGN KEY"
    ) {
      constraint.referenced_table.columns.push(
        constraintColumn.referenced_column_name
      );
    }
  }

  // -----------------------------------------------------------------------
  //  DB Schema
  // -----------------------------------------------------------------------

  const result: DBSchema = {
    tables: Array.from(tableMap.values()),
  };

  if (enumRows && enumRows.length) {
    result.enums = enumRows;
  }

  return result;
}

export async function getDbSchemaImplementation(
  input: z.infer<typeof GetDbSchemaInputSchema>,
  config: SQLToolConfig,
  _context: RequestContext
): Promise<z.infer<typeof GetDbSchemaOutputSchema>> {
  const client = createDBClient(config);

  client.setSchemas(input.schemas);

  try {
    return await getDbSchema(client);
  } finally {
    await client.close();
  }
}

export const GetDbSchemaTool: ToolDefinition<
  typeof GetDbSchemaInputSchema,
  typeof GetDbSchemaOutputSchema,
  SQLToolConfig
> = {
  provider: "local",
  type: "sql",
  name: "getDbSchema",
  description:
    "Get database schema information including tables, columns, constraints, and enums.",
  inputSchema: z.toJSONSchema(GetDbSchemaInputSchema),
  outputSchema: z.toJSONSchema(GetDbSchemaOutputSchema),
  implementation: getDbSchemaImplementation,
};

export async function executeSqlImplementation(
  input: z.infer<typeof ExecuteSqlInputSchema>,
  config: SQLToolConfig,
  _context: RequestContext
): Promise<z.infer<typeof ExecuteSqlOutputSchema>> {
  const client = createDBClient(config);

  try {
    return await client.execute(input.query);
  } finally {
    await client.close();
  }
}

export const ExecuteSqlTool: ToolDefinition<
  typeof ExecuteSqlInputSchema,
  typeof ExecuteSqlOutputSchema,
  SQLToolConfig
> = {
  provider: "local",
  type: "sql",
  name: "executeSql",
  description: "Execute SQL queries against a SQL database.",
  inputSchema: z.toJSONSchema(ExecuteSqlInputSchema),
  outputSchema: z.toJSONSchema(ExecuteSqlOutputSchema),
  implementation: executeSqlImplementation,
};

export const SQLTools = [GetDbSchemaTool, ExecuteSqlTool];

// TODO: add a tool to sample N rows from each table
