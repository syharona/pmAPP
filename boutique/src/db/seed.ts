/**
 * Dev seed: 1 shop (slug `demo`), its owner, 3 delivery zones, 5 products
 * (one with size variants), a trial subscription. Re-runnable: the demo shop
 * is deleted (cascade) and recreated. Refuses to run in production.
 *
 *   npm run db:seed
 */
import { eq } from "drizzle-orm";
import { db, pool } from "./index";
import {
  deliveryZones,
  memberships,
  products,
  productVariants,
  shops,
  stockMovements,
  subscriptions,
  users,
} from "./schema";
import { shopScope } from "./scoped";
import { nextProductCode } from "./sequences";

if (process.env.NODE_ENV === "production" && process.env.ALLOW_SEED !== "1") {
  console.error("Seed refusé en production (ALLOW_SEED=1 pour forcer).");
  process.exit(1);
}

const OWNER_PHONE = "+221770000001";
const TRIAL_DAYS = 30;

type SeedProduct = { name: string; price: number; description?: string; stock: number | Record<string, number> };

const PRODUCTS: SeedProduct[] = [
  { name: "Robe wax", price: 15000, description: "Robe en wax, coupe évasée.", stock: { S: 2, M: 3, L: 1 } },
  { name: "Sac en cuir", price: 25000, description: "Sac à main en cuir, fabriqué à Dakar.", stock: 4 },
  { name: "Boubou homme brodé", price: 35000, stock: 2 },
  { name: "Encens thiouraye (pot)", price: 3000, stock: 20 },
  { name: "Sandales tressées", price: 8500, stock: 0 },
];

const ZONES = [
  { name: "Plateau", fee: 1500 },
  { name: "Parcelles Assainies", fee: 2000 },
  { name: "Pikine", fee: 2500 },
];

/** YYYY-MM-DD in Africa/Dakar. */
function dakarDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Dakar" }).format(d);
}

async function main() {
  await db.transaction(async (tx) => {
    await tx.delete(shops).where(eq(shops.slug, "demo"));

    const [owner] = await tx
      .insert(users)
      .values({ phone: OWNER_PHONE, name: "Awa Diop" })
      .onConflictDoUpdate({ target: users.phone, set: { name: "Awa Diop" } })
      .returning();
    if (!owner) throw new Error("user");

    const now = new Date();
    const trialEnd = new Date(now.getTime() + TRIAL_DAYS * 86_400_000);
    const [shop] = await tx
      .insert(shops)
      .values({ slug: "demo", name: "Awa Couture", waveNumber: OWNER_PHONE, status: "trial", trialEndsAt: trialEnd })
      .returning();
    if (!shop) throw new Error("shop");
    const s = shopScope(shop.id);

    await tx.insert(memberships).values(s.values(memberships, { userId: owner.id, role: "owner" }));
    await tx.insert(subscriptions).values(
      s.values(subscriptions, {
        amount: 0,
        periodStart: dakarDate(now),
        periodEnd: dakarDate(trialEnd),
        status: "paid",
        waveRef: "ESSAI",
        paidAt: now,
      }),
    );
    await tx.insert(deliveryZones).values(ZONES.map((z) => s.values(deliveryZones, z)));

    for (const p of PRODUCTS) {
      const code = await nextProductCode(tx, shop.id);
      const [product] = await tx
        .insert(products)
        .values(s.values(products, { code, name: p.name, price: p.price, description: p.description ?? null }))
        .returning();
      if (!product) throw new Error("product");

      const variants =
        typeof p.stock === "number"
          ? [{ label: null, stock: p.stock }]
          : Object.entries(p.stock).map(([label, stock]) => ({ label, stock }));
      const rows = await tx
        .insert(productVariants)
        .values(variants.map((v) => ({ productId: product.id, ...v })))
        .returning();
      const moves = rows.filter((v) => v.stock > 0).map((v) => ({ variantId: v.id, delta: v.stock, reason: "create" as const, byUserId: owner.id }));
      if (moves.length) await tx.insert(stockMovements).values(moves);
    }

    console.log(`Boutique « ${shop.name} » créée : /${shop.slug} (propriétaire ${OWNER_PHONE}), ${PRODUCTS.length} produits.`);
  });
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
