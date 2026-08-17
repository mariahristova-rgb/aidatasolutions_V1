-- Course cohorts and registrations.
--
-- The ten-place limit is enforced here rather than in the browser: a seat is only
-- considered taken while a registration is PAID, or PENDING with an unexpired hold.

CREATE TABLE course_cohorts (
  id SERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  seats_total INTEGER NOT NULL CHECK (seats_total > 0),
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  currency TEXT NOT NULL DEFAULT 'eur',
  starts_on DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE course_registrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_id INTEGER NOT NULL REFERENCES course_cohorts(id),
  email TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  preferred_payment_method TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'PAID', 'EXPIRED', 'CANCELLED', 'FAILED')),
  hold_expires_at TIMESTAMPTZ,
  stripe_checkout_session_id TEXT,
  stripe_payment_intent_id TEXT,
  amount_cents INTEGER,
  currency TEXT,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seat counting for a cohort.
CREATE INDEX course_registrations_seat_idx
  ON course_registrations (cohort_id, status, hold_expires_at);

-- Webhook lookups, and a guard against processing one checkout twice.
CREATE UNIQUE INDEX course_registrations_checkout_session_idx
  ON course_registrations (stripe_checkout_session_id)
  WHERE stripe_checkout_session_id IS NOT NULL;

-- One live seat per email per cohort.
CREATE UNIQUE INDEX course_registrations_active_email_idx
  ON course_registrations (cohort_id, LOWER(email))
  WHERE status IN ('PENDING', 'PAID');

INSERT INTO course_cohorts (slug, title, seats_total, price_cents, currency, starts_on)
VALUES (
  'ai-data-foundations-2026-10',
  'AI Data Foundations for business leaders',
  10,
  55000,
  'eur',
  '2026-10-10'
)
ON CONFLICT (slug) DO NOTHING;
