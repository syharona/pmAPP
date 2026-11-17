/** Integration: needs DATABASE_URL (migrated). Skipped otherwise. */
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("per-shop sequences", async () => {
  const { db, pool } = await import("@/db");
  const { shops } = await import("@/db/schema");
  const { nextOrderNumber } = await import("@/db/sequences");

  afterAll(async () => {
    await db.delete(shops).where(eq(shops.slug, "test-sequences"));
    await pool.end();
  });

  it("hands out unique consecutive numbers under concurrency", async () => {
    await db.delete(shops).where(eq(shops.slug, "test-sequences"));
    const [shop] = await db
      .insert(shops)
      .values({ slug: "test-sequences", name: "Test", waveNumber: "+221770000099" })
      .returning();
    if (!shop) throw new Error("shop");

    const numbers = await Promise.all(
      Array.from({ length: 8 }, () => db.transaction((tx) => nextOrderNumber(tx, shop.id))),
    );
    expect([...numbers].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
