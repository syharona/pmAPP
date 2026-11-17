import { eq, sql } from "drizzle-orm";
import type { DbOrTx } from "./index";
import { shops } from "./schema";

/**
 * Per-shop sequential numbers (product `code`, order `number`).
 * Must run inside the transaction that inserts the row: the UPDATE row-locks
 * the shop, so concurrent callers are serialized and never get the same value.
 */
export async function nextProductCode(tx: DbOrTx, shopId: string): Promise<number> {
  const [row] = await tx
    .update(shops)
    .set({ nextProductCode: sql`${shops.nextProductCode} + 1` })
    .where(eq(shops.id, shopId))
    .returning({ value: sql<number>`${shops.nextProductCode} - 1` });
  if (!row) throw new Error("Boutique introuvable");
  return row.value;
}

export async function nextOrderNumber(tx: DbOrTx, shopId: string): Promise<number> {
  const [row] = await tx
    .update(shops)
    .set({ nextOrderNumber: sql`${shops.nextOrderNumber} + 1` })
    .where(eq(shops.id, shopId))
    .returning({ value: sql<number>`${shops.nextOrderNumber} - 1` });
  if (!row) throw new Error("Boutique introuvable");
  return row.value;
}
