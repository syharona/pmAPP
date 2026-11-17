/**
 * Data model — see SPEC.md §8.
 *
 * Conventions:
 * - Money: integer XOF (`integer`), never decimals.
 * - Phones: E.164 text (`+2217XXXXXXXX`), enforced by CHECK constraints.
 * - Timestamps: timestamptz; business day computed in Africa/Dakar.
 * - Tenant tables carry `shop_id`. Child tables (product_variants, order_items,
 *   order_events, stock_movements) are only reached through a scoped parent.
 */
import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------- helpers

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
const shopId = () =>
  uuid("shop_id")
    .notNull()
    .references(() => shops.id, { onDelete: "cascade" });

/** E.164: `+` then 8 to 15 digits, no leading zero. */
const e164Check = (name: string, column: string) =>
  check(name, sql.raw(`${column} ~ '^\\+[1-9][0-9]{7,14}$'`));

// ---------------------------------------------------------------- enums

export const shopStatus = pgEnum("shop_status", ["trial", "active", "suspended"]);
export const memberRole = pgEnum("member_role", ["owner", "staff"]);
export const subscriptionStatus = pgEnum("subscription_status", ["pending", "paid"]);
export const paymentMethod = pgEnum("payment_method", ["cod", "wave"]);
export const paymentStatus = pgEnum("payment_status", ["unpaid", "paid_wave", "paid_cash"]);
export const orderStatus = pgEnum("order_status", [
  "new",
  "confirmed",
  "shipping",
  "delivered",
  "cancelled",
  "returned",
]);
export const orderSource = pgEnum("order_source", ["link", "bot", "live"]);
export const stockReason = pgEnum("stock_reason", [
  "order",
  "cancel",
  "return",
  "manual",
  "bot_update",
  "create",
]);
export const waDirection = pgEnum("wa_direction", ["in", "out"]);

// ---------------------------------------------------------------- identity

export const users = pgTable(
  "users",
  {
    id: id(),
    phone: text("phone").notNull().unique(),
    name: text("name"),
    isAdmin: boolean("is_admin").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [e164Check("users_phone_e164", "phone")],
);

export const shops = pgTable(
  "shops",
  {
    id: id(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    waveNumber: text("wave_number").notNull(),
    status: shopStatus("status").notNull().default("trial"),
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
    nextProductCode: integer("next_product_code").notNull().default(1),
    nextOrderNumber: integer("next_order_number").notNull().default(1),
    createdAt: createdAt(),
  },
  (t) => [
    e164Check("shops_wave_number_e164", "wave_number"),
    check("shops_slug_format", sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
  ],
);

export const memberships = pgTable(
  "memberships",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    shopId: shopId(),
    role: memberRole("role").notNull().default("owner"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.shopId] }), index("memberships_shop_idx").on(t.shopId)],
);

// ---------------------------------------------------------------- billing

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: id(),
    shopId: shopId(),
    amount: integer("amount").notNull().default(3000),
    periodStart: date("period_start", { mode: "string" }).notNull(),
    periodEnd: date("period_end", { mode: "string" }).notNull(),
    status: subscriptionStatus("status").notNull().default("pending"),
    waveRef: text("wave_ref"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("subscriptions_shop_idx").on(t.shopId, t.periodEnd),
    check("subscriptions_amount_nonneg", sql`${t.amount} >= 0`),
    check("subscriptions_period_order", sql`${t.periodEnd} >= ${t.periodStart}`),
  ],
);

// ---------------------------------------------------------------- catalog

export const deliveryZones = pgTable(
  "delivery_zones",
  {
    id: id(),
    shopId: shopId(),
    name: text("name").notNull(),
    fee: integer("fee").notNull(),
    isActive: boolean("is_active").notNull().default(true),
  },
  (t) => [
    index("delivery_zones_shop_idx").on(t.shopId),
    check("delivery_zones_fee_nonneg", sql`${t.fee} >= 0`),
  ],
);

export const products = pgTable(
  "products",
  {
    id: id(),
    shopId: shopId(),
    code: integer("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    price: integer("price").notNull(),
    photoUrl: text("photo_url"),
    thumbUrl: text("thumb_url"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("products_shop_code_uq").on(t.shopId, t.code),
    check("products_price_nonneg", sql`${t.price} >= 0`),
    check("products_code_pos", sql`${t.code} > 0`),
  ],
);

export const productVariants = pgTable(
  "product_variants",
  {
    id: id(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    /** null = the product's single default variant. */
    label: text("label"),
    stock: integer("stock").notNull().default(0),
  },
  (t) => [
    // NULLS NOT DISTINCT: at most one default (null-label) variant per product.
    unique("product_variants_product_label_uq").on(t.productId, t.label).nullsNotDistinct(),
    check("product_variants_stock_nonneg", sql`${t.stock} >= 0`),
  ],
);

// ---------------------------------------------------------------- orders

export const customers = pgTable(
  "customers",
  {
    id: id(),
    shopId: shopId(),
    phone: text("phone").notNull(),
    name: text("name"),
    lastZoneId: uuid("last_zone_id").references(() => deliveryZones.id, { onDelete: "set null" }),
    lastAddress: text("last_address"),
    createdAt: createdAt(),
  },
  (t) => [unique("customers_shop_phone_uq").on(t.shopId, t.phone), e164Check("customers_phone_e164", "phone")],
);

export const orders = pgTable(
  "orders",
  {
    id: id(),
    shopId: shopId(),
    number: integer("number").notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    zoneId: uuid("zone_id").references(() => deliveryZones.id, { onDelete: "set null" }),
    address: text("address"),
    subtotal: integer("subtotal").notNull(),
    deliveryFee: integer("delivery_fee").notNull().default(0),
    total: integer("total").notNull(),
    paymentMethod: paymentMethod("payment_method").notNull(),
    paymentStatus: paymentStatus("payment_status").notNull().default("unpaid"),
    status: orderStatus("status").notNull().default("new"),
    source: orderSource("source").notNull().default("link"),
    note: text("note"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("orders_shop_number_uq").on(t.shopId, t.number),
    index("orders_shop_created_idx").on(t.shopId, t.createdAt),
    index("orders_shop_status_idx").on(t.shopId, t.status),
    index("orders_customer_idx").on(t.customerId),
    check("orders_amounts_nonneg", sql`${t.subtotal} >= 0 AND ${t.deliveryFee} >= 0`),
    check("orders_total_sum", sql`${t.total} = ${t.subtotal} + ${t.deliveryFee}`),
  ],
);

export const orderItems = pgTable(
  "order_items",
  {
    id: id(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => productVariants.id),
    // Snapshots: the order keeps what was sold even if the product changes.
    productName: text("product_name").notNull(),
    variantLabel: text("variant_label"),
    unitPrice: integer("unit_price").notNull(),
    qty: integer("qty").notNull(),
  },
  (t) => [
    index("order_items_order_idx").on(t.orderId),
    index("order_items_variant_idx").on(t.variantId),
    check("order_items_qty_pos", sql`${t.qty} > 0`),
    check("order_items_unit_price_nonneg", sql`${t.unitPrice} >= 0`),
  ],
);

export const orderEvents = pgTable(
  "order_events",
  {
    id: id(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    /** null on the creation event. */
    fromStatus: orderStatus("from_status"),
    toStatus: orderStatus("to_status").notNull(),
    byUserId: uuid("by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("order_events_order_idx").on(t.orderId, t.createdAt)],
);

export const stockMovements = pgTable(
  "stock_movements",
  {
    id: id(),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => productVariants.id, { onDelete: "cascade" }),
    delta: integer("delta").notNull(),
    reason: stockReason("reason").notNull(),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "set null" }),
    byUserId: uuid("by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("stock_movements_variant_idx").on(t.variantId, t.createdAt)],
);

// ---------------------------------------------------------------- WhatsApp

/** Bot state machine, one row per WhatsApp sender. */
export const waConversations = pgTable("wa_conversations", {
  phone: text("phone").primaryKey(),
  state: text("state").notNull().default("idle"),
  context: jsonb("context").$type<Record<string, unknown>>().notNull().default({}),
  updatedAt: updatedAt(),
});

/** Idempotency (unique wamid) + audit of every inbound/outbound message. */
export const waMessages = pgTable(
  "wa_messages",
  {
    id: id(),
    wamid: text("wamid").unique(),
    direction: waDirection("direction").notNull(),
    phone: text("phone").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    status: text("status"),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [
    index("wa_messages_phone_idx").on(t.phone, t.createdAt),
    index("wa_messages_errors_idx").on(t.createdAt).where(sql`${t.error} IS NOT NULL`),
  ],
);

// ---------------------------------------------------------------- auth

/** One-time WhatsApp login links (10 min, single use). Only the SHA-256 hash is stored. */
export const loginTokens = pgTable(
  "login_tokens",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("login_tokens_hash_uq").on(t.tokenHash)],
);

/** Dashboard sessions (httpOnly cookie holds the raw token, DB holds its SHA-256 hash). */
export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("sessions_token_hash_uq").on(t.tokenHash), index("sessions_user_idx").on(t.userId)],
);

// ---------------------------------------------------------------- cron

/** Idempotency for scheduled jobs: one row per (job, shop, Dakar day). */
export const jobRuns = pgTable(
  "job_runs",
  {
    job: text("job").notNull(),
    shopId: shopId(),
    runDate: date("run_date", { mode: "string" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.job, t.shopId, t.runDate] })],
);

// ---------------------------------------------------------------- relations

export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(memberships),
}));

export const shopsRelations = relations(shops, ({ many }) => ({
  memberships: many(memberships),
  subscriptions: many(subscriptions),
  zones: many(deliveryZones),
  products: many(products),
  customers: many(customers),
  orders: many(orders),
}));

export const membershipsRelations = relations(memberships, ({ one }) => ({
  user: one(users, { fields: [memberships.userId], references: [users.id] }),
  shop: one(shops, { fields: [memberships.shopId], references: [shops.id] }),
}));

export const productsRelations = relations(products, ({ one, many }) => ({
  shop: one(shops, { fields: [products.shopId], references: [shops.id] }),
  variants: many(productVariants),
}));

export const productVariantsRelations = relations(productVariants, ({ one, many }) => ({
  product: one(products, { fields: [productVariants.productId], references: [products.id] }),
  movements: many(stockMovements),
}));

export const customersRelations = relations(customers, ({ one, many }) => ({
  shop: one(shops, { fields: [customers.shopId], references: [shops.id] }),
  lastZone: one(deliveryZones, { fields: [customers.lastZoneId], references: [deliveryZones.id] }),
  orders: many(orders),
}));

export const ordersRelations = relations(orders, ({ one, many }) => ({
  shop: one(shops, { fields: [orders.shopId], references: [shops.id] }),
  customer: one(customers, { fields: [orders.customerId], references: [customers.id] }),
  zone: one(deliveryZones, { fields: [orders.zoneId], references: [deliveryZones.id] }),
  items: many(orderItems),
  events: many(orderEvents),
}));

export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, { fields: [orderItems.orderId], references: [orders.id] }),
  variant: one(productVariants, { fields: [orderItems.variantId], references: [productVariants.id] }),
}));

export const orderEventsRelations = relations(orderEvents, ({ one }) => ({
  order: one(orders, { fields: [orderEvents.orderId], references: [orders.id] }),
}));

export const stockMovementsRelations = relations(stockMovements, ({ one }) => ({
  variant: one(productVariants, { fields: [stockMovements.variantId], references: [productVariants.id] }),
  order: one(orders, { fields: [stockMovements.orderId], references: [orders.id] }),
}));

// ---------------------------------------------------------------- types

export type User = typeof users.$inferSelect;
export type Shop = typeof shops.$inferSelect;
export type Product = typeof products.$inferSelect;
export type ProductVariant = typeof productVariants.$inferSelect;
export type DeliveryZone = typeof deliveryZones.$inferSelect;
export type Customer = typeof customers.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type OrderItem = typeof orderItems.$inferSelect;
export type OrderStatus = (typeof orderStatus.enumValues)[number];
export type StockReason = (typeof stockReason.enumValues)[number];
