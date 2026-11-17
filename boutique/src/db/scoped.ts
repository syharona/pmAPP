/**
 * Shop-scoped query helpers. Route handlers and bot flows NEVER query tenant
 * tables directly: they get a scope (from the session or the bot sender's
 * membership) and build every WHERE / INSERT through it.
 *
 *   const s = shopScope(session.shopId);
 *   await db.select().from(products).where(s.where(products, eq(products.code, 3)));
 *   await db.insert(deliveryZones).values(s.values(deliveryZones, { name: "Plateau", fee: 1500 }));
 *
 * Child tables (product_variants, order_items, order_events, stock_movements)
 * have no shop_id: reach them by joining a scoped parent.
 */
import { and, eq, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

export type TenantTable = PgTable & { shopId: PgColumn };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ShopScope {
  readonly shopId: string;
  /** `shop_id = :shopId AND …conds` */
  where(table: TenantTable, ...conds: (SQL | undefined)[]): SQL;
  /** Insert values with `shopId` forced to the scope (callers cannot set it). */
  values<T extends TenantTable>(table: T, values: Omit<T["$inferInsert"], "shopId">): T["$inferInsert"];
}

export function shopScope(shopId: string): ShopScope {
  if (!UUID_RE.test(shopId)) throw new Error("shopScope: shopId invalide");
  return {
    shopId,
    where(table, ...conds) {
      return and(eq(table.shopId, shopId), ...conds) as SQL;
    },
    values(_table, values) {
      return { ...values, shopId } as never;
    },
  };
}
