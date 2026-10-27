-- Physical (soft cover) book stock and orders.
--
-- Stock is held in two phases so that a browser can never oversell:
--   1. Checkout creation inserts a PENDING order with RESERVED items and a
--      hold that outlives the Stripe Checkout Session. Reserved copies are
--      subtracted from availability but are still physically on hand.
--   2. The verified Stripe webhook deducts the copies from stock_on_hand once
--      and flips the order to DEDUCTED, so a retried event is a no-op.
-- An abandoned or expired checkout only ever releases a reservation.

CREATE TABLE book_stock (
  book_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  currency TEXT NOT NULL DEFAULT 'eur',
  stock_on_hand INTEGER NOT NULL CHECK (stock_on_hand >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE SEQUENCE book_order_number_seq START 1001;

CREATE TABLE book_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number TEXT NOT NULL UNIQUE
    DEFAULT 'SC-' || LPAD(nextval('book_order_number_seq')::text, 5, '0'),
  customer_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,

  delivery_method TEXT NOT NULL CHECK (delivery_method IN ('ADDRESS', 'OFFICE', 'APT')),
  -- Human readable destination, rebuilt server-side from validated Speedy data.
  delivery_summary TEXT NOT NULL,
  -- Speedy office / automated parcel machine destination.
  speedy_office_id INTEGER,
  -- Speedy address destination, as validated through the Speedy location API.
  speedy_site_id BIGINT,
  speedy_site_name TEXT,
  speedy_post_code TEXT,
  speedy_street_id BIGINT,
  speedy_street_name TEXT,
  speedy_street_no TEXT,
  speedy_block_no TEXT,
  speedy_entrance_no TEXT,
  speedy_floor_no TEXT,
  speedy_apartment_no TEXT,
  speedy_address_note TEXT,

  subtotal_cents INTEGER NOT NULL CHECK (subtotal_cents > 0),
  currency TEXT NOT NULL DEFAULT 'eur',
  amount_paid_cents INTEGER,

  payment_status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (payment_status IN ('PENDING', 'PAID', 'EXPIRED', 'FAILED', 'CANCELLED')),
  stripe_checkout_session_id TEXT,
  stripe_payment_intent_id TEXT,
  hold_expires_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,

  inventory_status TEXT NOT NULL DEFAULT 'RESERVED'
    CHECK (inventory_status IN ('RESERVED', 'DEDUCTED', 'RELEASED', 'OVERSOLD')),
  fulfillment_status TEXT NOT NULL DEFAULT 'AWAITING_PAYMENT'
    CHECK (fulfillment_status IN (
      'AWAITING_PAYMENT', 'READY_TO_SHIP', 'SHIPMENT_CREATED', 'SHIPMENT_FAILED', 'CANCELLED'
    )),
  speedy_shipment_id TEXT,
  speedy_shipment_error TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE book_order_items (
  order_id UUID NOT NULL REFERENCES book_orders(id) ON DELETE CASCADE,
  book_id TEXT NOT NULL REFERENCES book_stock(book_id),
  quantity INTEGER NOT NULL CHECK (quantity >= 1 AND quantity <= 2),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents > 0),
  PRIMARY KEY (order_id, book_id)
);

-- Counting reserved copies per book.
CREATE INDEX book_order_items_book_idx ON book_order_items (book_id);

-- Hold expiry sweeps and reservation counting.
CREATE INDEX book_orders_hold_idx
  ON book_orders (payment_status, inventory_status, hold_expires_at);

-- One order per Stripe Checkout Session.
CREATE UNIQUE INDEX book_orders_checkout_session_idx
  ON book_orders (stripe_checkout_session_id)
  WHERE stripe_checkout_session_id IS NOT NULL;

-- First-line webhook idempotency: an event id can only be recorded once.
CREATE TABLE stripe_webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO book_stock (book_id, title, price_cents, currency, stock_on_hand)
VALUES
  ('book1', 'AI Doesn''t Know What Your Data Means', 2400, 'eur', 10),
  ('book2', 'Think Like a Data Engineer', 2499, 'eur', 10)
ON CONFLICT (book_id) DO NOTHING;
