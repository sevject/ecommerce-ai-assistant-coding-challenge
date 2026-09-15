/**
 * The description of the data that the model plans queries against.
 *
 * This is the single place where the data model is explained to the LLM. It is
 * deliberately hand-written rather than generated from `sqlite_master`: the
 * column list alone does not convey the two-price rule or the string-comparable
 * timestamps, and those are exactly the things a model gets wrong.
 */
export const SCHEMA_CONTEXT = `
Tables (SQLite):

  users(id INTEGER PK, name TEXT, email TEXT UNIQUE, created_at TEXT)
  products(id INTEGER PK, name TEXT, sku TEXT UNIQUE, current_price_cents INTEGER, created_at TEXT)
  orders(id INTEGER PK, user_id INTEGER -> users.id, ordered_at TEXT)
  order_items(id INTEGER PK, order_id INTEGER -> orders.id, product_id INTEGER -> products.id,
              quantity INTEGER, unit_price_cents INTEGER)

Relationships:
  A user places orders. Each order has one or more order_items. Each order_item
  points at one product. There is no total column on orders: an order's value is
  SUM(oi.quantity * oi.unit_price_cents) over its line items.

Money:
  All monetary values are INTEGER CENTS. Never divide by 100 in SQL and never use
  floating point for money. Return cents and let the caller format them.

  There are two prices and picking the wrong one is the most common mistake:
    - order_items.unit_price_cents is what was actually charged per unit at the
      time of the order. Use this for anything about past orders, revenue, order
      value, or what a customer spent.
    - products.current_price_cents is today's catalog price. Use this ONLY when
      the question is explicitly about current or catalog pricing.

Timestamps:
  ISO 8601 UTC strings, e.g. '2026-07-20T12:00:00.000Z'. They sort correctly as
  plain text, so compare them as strings. For a date range use half-open bounds
  on the date prefix, e.g.
    WHERE o.ordered_at >= '2026-07-14T00:00:00.000Z'
      AND o.ordered_at <  '2026-07-21T00:00:00.000Z'
  You can also use SQLite date functions, e.g. date(o.ordered_at) or
  date('2026-07-20', '-7 days').
`.trim();
