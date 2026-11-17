import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;
/** A transaction handle or the root db: domain functions accept either. */
export type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

const globalForDb = globalThis as unknown as { __pool?: Pool };

function createPool(): Pool {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL manquant");
  return new Pool({ connectionString: url, max: 10 });
}

// Reuse the pool across Next.js dev hot reloads.
const pool = globalForDb.__pool ?? createPool();
if (process.env.NODE_ENV !== "production") globalForDb.__pool = pool;

export const db: Db = drizzle(pool, { schema });
export { pool, schema };
