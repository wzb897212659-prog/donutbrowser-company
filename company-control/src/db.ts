import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient, type QueryResultRow } from "pg";

export class Database {
  readonly pool: Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 10 });
  }

  async migrate(): Promise<void> {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      join(here, "schema.sql"),
      join(here, "..", "src", "schema.sql"),
    ];
    let sql: string | undefined;
    for (const candidate of candidates) {
      try {
        sql = await readFile(candidate, "utf8");
        break;
      } catch {
        // Try the source-tree fallback in production images.
      }
    }
    if (!sql) throw new Error("schema.sql was not found");
    await this.pool.query(sql);
  }

  async query<T extends QueryResultRow>(text: string, values: unknown[] = []) {
    return this.pool.query<T>(text, values);
  }

  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const value = await fn(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
