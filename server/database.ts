import { Pool, type PoolClient, type PoolConfig } from "pg";

export type DatabaseRow = Record<string, unknown>;

export type DatabaseValue =
  | string
  | number
  | boolean
  | bigint
  | Date
  | Buffer
  | null
  | undefined
  | Record<string, unknown>
  | unknown[];

export type RunResult<Row extends DatabaseRow = DatabaseRow> = {
  changes: number;
  rows: Row[];
};

export type TransactionOptions = {
  isolationLevel?: "read committed" | "repeatable read" | "serializable";
  readOnly?: boolean;
};

export type DatabaseOptions = {
  connectionString?: string;
  schema?: string;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  statementTimeoutMs?: number;
  applicationName?: string;
  ssl?: PoolConfig["ssl"];
  createSchema?: boolean;
  dropSchemaOnClose?: boolean;
};

type QueryResult<Row extends DatabaseRow> = {
  rows: Row[];
  rowCount: number | null;
};

type QueryExecutor = {
  query: <Row extends DatabaseRow = DatabaseRow>(
    sql: string,
    params?: DatabaseValue[],
  ) => Promise<QueryResult<Row> | QueryResult<Row>[]>;
};

function assertSchemaName(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(value)) {
    throw new Error(`Invalid PostgreSQL schema name: ${value}`);
  }
  return value;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * Converts the repository's historical SQLite-style positional placeholders to
 * PostgreSQL placeholders. Question marks in strings, quoted identifiers,
 * comments and PostgreSQL dollar-quoted bodies are left untouched. A doubled
 * question mark (`??`) emits one literal question mark for JSON operators.
 */
export function postgresPlaceholders(source: string): string {
  let result = "";
  let parameter = 0;
  let index = 0;
  let state: "plain" | "single" | "double" | "line-comment" | "block-comment" | "dollar" = "plain";
  let dollarTag = "";

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (state === "single") {
      result += char;
      index += 1;
      if (char === "'" && next === "'") {
        result += next;
        index += 1;
      } else if (char === "'") {
        state = "plain";
      }
      continue;
    }

    if (state === "double") {
      result += char;
      index += 1;
      if (char === '"' && next === '"') {
        result += next;
        index += 1;
      } else if (char === '"') {
        state = "plain";
      }
      continue;
    }

    if (state === "line-comment") {
      result += char;
      index += 1;
      if (char === "\n") state = "plain";
      continue;
    }

    if (state === "block-comment") {
      result += char;
      index += 1;
      if (char === "*" && next === "/") {
        result += next;
        index += 1;
        state = "plain";
      }
      continue;
    }

    if (state === "dollar") {
      if (source.startsWith(dollarTag, index)) {
        result += dollarTag;
        index += dollarTag.length;
        state = "plain";
      } else {
        result += char;
        index += 1;
      }
      continue;
    }

    if (char === "'") {
      state = "single";
      result += char;
      index += 1;
      continue;
    }
    if (char === '"') {
      state = "double";
      result += char;
      index += 1;
      continue;
    }
    if (char === "-" && next === "-") {
      state = "line-comment";
      result += "--";
      index += 2;
      continue;
    }
    if (char === "/" && next === "*") {
      state = "block-comment";
      result += "/*";
      index += 2;
      continue;
    }
    if (char === "$") {
      const match = source.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/u);
      if (match) {
        dollarTag = match[0];
        state = "dollar";
        result += dollarTag;
        index += dollarTag.length;
        continue;
      }
    }
    if (char === "?" && next === "?") {
      result += "?";
      index += 2;
      continue;
    }
    if (char === "?") {
      parameter += 1;
      result += `$${parameter}`;
      index += 1;
      continue;
    }

    result += char;
    index += 1;
  }

  return result;
}

function normalizeParameters(parameters: DatabaseValue[]): DatabaseValue[] {
  return parameters.map((value) => value === undefined ? null : value);
}

export class PreparedStatement<Row extends DatabaseRow = DatabaseRow> {
  readonly sql: string;

  constructor(
    private readonly database: PostgresDatabase,
    source: string,
  ) {
    this.sql = postgresPlaceholders(source);
  }

  async get(...parameters: DatabaseValue[]): Promise<Row | undefined> {
    const result = await this.database.queryNative<Row>(this.sql, parameters);
    return result.rows[0];
  }

  async all(...parameters: DatabaseValue[]): Promise<Row[]> {
    const result = await this.database.queryNative<Row>(this.sql, parameters);
    return result.rows;
  }

  async run(...parameters: DatabaseValue[]): Promise<RunResult<Row>> {
    const result = await this.database.queryNative<Row>(this.sql, parameters);
    return { changes: result.rowCount ?? 0, rows: result.rows };
  }
}

export class PostgresDatabase {
  private closed = false;
  private savepointCounter = 0;

  constructor(
    private readonly pool: Pool,
    private readonly executor: QueryExecutor,
    readonly schema: string,
    private readonly client?: PoolClient,
    private readonly dropSchemaOnClose = false,
  ) {}

  prepare<Row extends DatabaseRow = DatabaseRow>(sql: string): PreparedStatement<Row> {
    this.assertOpen();
    return new PreparedStatement<Row>(this, sql);
  }

  async query<Row extends DatabaseRow = DatabaseRow>(
    sql: string,
    parameters: DatabaseValue[] = [],
  ): Promise<QueryResult<Row>> {
    return this.queryNative<Row>(postgresPlaceholders(sql), parameters);
  }

  async one<Row extends DatabaseRow = DatabaseRow>(
    sql: string,
    parameters: DatabaseValue[] = [],
  ): Promise<Row | undefined> {
    return (await this.query<Row>(sql, parameters)).rows[0];
  }

  async many<Row extends DatabaseRow = DatabaseRow>(
    sql: string,
    parameters: DatabaseValue[] = [],
  ): Promise<Row[]> {
    return (await this.query<Row>(sql, parameters)).rows;
  }

  async execute<Row extends DatabaseRow = DatabaseRow>(
    sql: string,
    parameters: DatabaseValue[] = [],
  ): Promise<RunResult<Row>> {
    const result = await this.query<Row>(sql, parameters);
    return { changes: result.rowCount ?? 0, rows: result.rows };
  }

  async transaction<T>(
    operation: (database: PostgresDatabase) => T | Promise<T>,
    options?: TransactionOptions,
  ): Promise<T> {
    this.assertOpen();
    if (this.client) {
      if (options !== undefined) {
        throw new Error("Nested transaction options are not supported by PostgreSQL savepoints");
      }
      return this.nestedTransaction(operation);
    }

    const client = await this.pool.connect();
    const transactionDatabase = new PostgresDatabase(this.pool, client as unknown as QueryExecutor, this.schema, client);
    try {
      await client.query("BEGIN");
      if (options?.isolationLevel) {
        const isolation = options.isolationLevel.toUpperCase();
        await client.query(`SET TRANSACTION ISOLATION LEVEL ${isolation}`);
      }
      if (options?.readOnly) await client.query("SET TRANSACTION READ ONLY");
      const result = await operation(transactionDatabase);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original error; a broken connection is discarded by pg.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async nestedTransaction<T>(operation: (database: PostgresDatabase) => T | Promise<T>): Promise<T> {
    const savepoint = `yuxiaoman_sp_${this.savepointCounter += 1}`;
    await this.client!.query(`SAVEPOINT ${savepoint}`);
    try {
      const result = await operation(this);
      await this.client!.query(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      await this.client!.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.client || this.closed) return;
    this.closed = true;
    try {
      if (this.dropSchemaOnClose && this.schema !== "public") {
        await this.pool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(this.schema)} CASCADE`);
      }
    } finally {
      await this.pool.end();
    }
  }

  async queryNative<Row extends DatabaseRow = DatabaseRow>(
    sql: string,
    parameters: DatabaseValue[] = [],
  ): Promise<QueryResult<Row>> {
    this.assertOpen();
    const result = await this.executor.query<Row>(sql, normalizeParameters(parameters));
    if (!Array.isArray(result)) return result;
    return result.at(-1) ?? { rows: [], rowCount: 0 };
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("PostgreSQL database is closed");
  }
}

export type AppDatabase = PostgresDatabase;
export type Database = PostgresDatabase;

export async function createPostgresDatabase(options: DatabaseOptions = {}): Promise<PostgresDatabase> {
  const schema = assertSchemaName(options.schema ?? process.env.YUXIAOMAN_DB_SCHEMA ?? "public");
  const dropSchemaOnClose = options.dropSchemaOnClose
    ?? process.env.YUXIAOMAN_DROP_SCHEMA_ON_CLOSE === "true";
  const pool = new Pool({
    connectionString: options.connectionString ?? process.env.DATABASE_URL,
    max: options.max ?? Number(process.env.PGPOOL_MAX ?? 10),
    idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
    statement_timeout: options.statementTimeoutMs ?? Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? 10_000),
    application_name: options.applicationName ?? "yuxiaoman-api",
    ssl: options.ssl,
    options: `-c search_path=${schema},public`,
  });
  pool.on("error", (error) => {
    console.error("Unexpected PostgreSQL idle client error", error);
  });

  try {
    if (schema !== "public" && options.createSchema !== false) {
      await pool.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema)}`);
    }
    const readiness = await pool.query<{ current_schema: string | null }>(
      "SELECT current_schema() AS current_schema",
    );
    if (readiness.rows[0]?.current_schema !== schema) {
      throw new Error(`PostgreSQL search_path did not select required schema: ${schema}`);
    }
    return new PostgresDatabase(
      pool,
      pool as unknown as QueryExecutor,
      schema,
      undefined,
      dropSchemaOnClose,
    );
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
}
