import { eq } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { deliveryZones, products } from "@/db/schema";
import { shopScope } from "@/db/scoped";

const SHOP = "11111111-1111-4111-8111-111111111111";
const dialect = new PgDialect();

describe("shopScope", () => {
  it("always prefixes the WHERE with shop_id", () => {
    const where = shopScope(SHOP).where(products, eq(products.code, 3));
    const q = dialect.sqlToQuery(where);
    expect(q.sql).toBe('("products"."shop_id" = $1 and "products"."code" = $2)');
    expect(q.params).toEqual([SHOP, 3]);
  });

  it("works with no extra condition", () => {
    const q = dialect.sqlToQuery(shopScope(SHOP).where(products));
    expect(q.params).toEqual([SHOP]);
  });

  it("forces shopId on insert values", () => {
    const v = shopScope(SHOP).values(deliveryZones, { name: "Plateau", fee: 1500, shopId: "evil" } as never);
    expect(v.shopId).toBe(SHOP);
  });

  it("rejects a non-uuid shop id", () => {
    expect(() => shopScope("")).toThrow();
    expect(() => shopScope("1 OR 1=1")).toThrow();
  });
});
