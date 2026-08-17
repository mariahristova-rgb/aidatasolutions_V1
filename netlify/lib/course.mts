import { getDatabase } from '@netlify/database'

/** The cohort the course page sells. Seeded by the initial migration. */
export const COHORT_SLUG = 'ai-data-foundations-2026-10'

/**
 * How long a seat stays reserved while someone completes Stripe Checkout.
 * Stripe requires a Checkout Session to live for at least 30 minutes, so the
 * hold and the session are both given the same 60 minute window.
 */
export const HOLD_MINUTES = 60

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const SEATS_TAKEN_SQL = `
  SELECT COUNT(*)::int AS taken
    FROM course_registrations
   WHERE cohort_id = $1
     AND (status = 'PAID' OR (status = 'PENDING' AND hold_expires_at > NOW()))
`

export type Cohort = {
  id: number
  slug: string
  title: string
  seats_total: number
  price_cents: number
  currency: string
  starts_on: string | null
}

export type Registration = {
  id: string
  cohort_id: number
  email: string
  first_name: string
  last_name: string
  phone: string
  status: string
  hold_expires_at: string | null
  stripe_checkout_session_id: string | null
  amount_cents: number | null
  currency: string | null
}

export type Availability = {
  cohort: { slug: string; title: string; startsOn: string | null }
  seatsTotal: number
  seatsTaken: number
  seatsAvailable: number
  priceCents: number
  currency: string
}

export type RegistrationInput = {
  email: string
  firstName: string
  lastName: string
  phone: string
  paymentMethod: string | null
}

export type ReserveResult =
  | { ok: true; registration: Registration; cohort: Cohort; seatsAvailable: number }
  | { ok: false; code: 'FULL' | 'ALREADY_PAID' | 'NO_COHORT'; seatsAvailable: number }

export function isRegistrationId(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

export async function readAvailability(): Promise<Availability | null> {
  const db = getDatabase()
  const rows = await db.sql`
    SELECT c.slug,
           c.title,
           c.starts_on,
           c.seats_total,
           c.price_cents,
           c.currency,
           (
             SELECT COUNT(*)::int
               FROM course_registrations r
              WHERE r.cohort_id = c.id
                AND (r.status = 'PAID' OR (r.status = 'PENDING' AND r.hold_expires_at > NOW()))
           ) AS seats_taken
      FROM course_cohorts c
     WHERE c.slug = ${COHORT_SLUG}
  `

  const row = rows[0]
  if (!row) return null

  return {
    cohort: { slug: row.slug, title: row.title, startsOn: row.starts_on ?? null },
    seatsTotal: row.seats_total,
    seatsTaken: row.seats_taken,
    seatsAvailable: Math.max(0, row.seats_total - row.seats_taken),
    priceCents: row.price_cents,
    currency: row.currency,
  }
}

export async function readRegistrationStatus(id: string): Promise<string | null> {
  if (!isRegistrationId(id)) return null

  const db = getDatabase()
  const rows = await db.sql`SELECT status FROM course_registrations WHERE id = ${id}`
  return rows[0]?.status ?? null
}

/**
 * Reserves one seat inside a single transaction. The cohort row is locked for the
 * duration, so two people submitting at the same moment can never share the last
 * seat. Returning to an unfinished registration reuses its existing seat instead
 * of consuming another one.
 */
export async function reserveSeat(input: RegistrationInput): Promise<ReserveResult> {
  const db = getDatabase()
  const client = await db.pool.connect()

  try {
    await client.query('BEGIN')

    const cohortResult = await client.query(
      `SELECT id, slug, title, seats_total, price_cents, currency, starts_on
         FROM course_cohorts
        WHERE slug = $1
          FOR UPDATE`,
      [COHORT_SLUG],
    )
    const cohort: Cohort | undefined = cohortResult.rows[0]
    if (!cohort) {
      await client.query('ROLLBACK')
      return { ok: false, code: 'NO_COHORT', seatsAvailable: 0 }
    }

    // Give back seats whose checkout was started but never completed.
    await client.query(
      `UPDATE course_registrations
          SET status = 'EXPIRED', updated_at = NOW()
        WHERE cohort_id = $1
          AND status = 'PENDING'
          AND hold_expires_at <= NOW()`,
      [cohort.id],
    )

    const existing = await client.query(
      `SELECT * FROM course_registrations
        WHERE cohort_id = $1
          AND LOWER(email) = LOWER($2)
          AND status IN ('PENDING', 'PAID')
        ORDER BY created_at DESC
        LIMIT 1`,
      [cohort.id, input.email],
    )

    if (existing.rows[0]?.status === 'PAID') {
      const taken = await client.query(SEATS_TAKEN_SQL, [cohort.id])
      await client.query('ROLLBACK')
      return {
        ok: false,
        code: 'ALREADY_PAID',
        seatsAvailable: Math.max(0, cohort.seats_total - taken.rows[0].taken),
      }
    }

    let registration: Registration

    if (existing.rows[0]) {
      const updated = await client.query(
        `UPDATE course_registrations
            SET first_name = $2,
                last_name = $3,
                phone = $4,
                preferred_payment_method = $5,
                amount_cents = $6,
                currency = $7,
                hold_expires_at = NOW() + make_interval(mins => $8::int),
                updated_at = NOW()
          WHERE id = $1
        RETURNING *`,
        [
          existing.rows[0].id,
          input.firstName,
          input.lastName,
          input.phone,
          input.paymentMethod,
          cohort.price_cents,
          cohort.currency,
          HOLD_MINUTES,
        ],
      )
      registration = updated.rows[0]
    } else {
      const taken = await client.query(SEATS_TAKEN_SQL, [cohort.id])
      if (taken.rows[0].taken >= cohort.seats_total) {
        await client.query('ROLLBACK')
        return { ok: false, code: 'FULL', seatsAvailable: 0 }
      }

      const inserted = await client.query(
        `INSERT INTO course_registrations
           (cohort_id, email, first_name, last_name, phone, preferred_payment_method,
            status, hold_expires_at, amount_cents, currency)
         VALUES ($1, $2, $3, $4, $5, $6,
                 'PENDING', NOW() + make_interval(mins => $7::int), $8, $9)
         RETURNING *`,
        [
          cohort.id,
          input.email,
          input.firstName,
          input.lastName,
          input.phone,
          input.paymentMethod,
          HOLD_MINUTES,
          cohort.price_cents,
          cohort.currency,
        ],
      )
      registration = inserted.rows[0]
    }

    const remaining = await client.query(SEATS_TAKEN_SQL, [cohort.id])
    await client.query('COMMIT')

    return {
      ok: true,
      registration,
      cohort,
      seatsAvailable: Math.max(0, cohort.seats_total - remaining.rows[0].taken),
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

export async function attachCheckoutSession(registrationId: string, sessionId: string): Promise<void> {
  const db = getDatabase()
  await db.sql`
    UPDATE course_registrations
       SET stripe_checkout_session_id = ${sessionId}, updated_at = NOW()
     WHERE id = ${registrationId}
  `
}

/** Frees the seat again when checkout could not be started, expired or failed. */
export async function releaseSeat(
  registrationId: string,
  status: 'CANCELLED' | 'EXPIRED' | 'FAILED',
): Promise<void> {
  const db = getDatabase()
  await db.sql`
    UPDATE course_registrations
       SET status = ${status}, hold_expires_at = NULL, updated_at = NOW()
     WHERE id = ${registrationId}
       AND status = 'PENDING'
  `
}

/**
 * Confirms a paid registration. A registration whose hold already lapsed is still
 * confirmed — the money was taken, so the seat is honoured.
 */
export async function markRegistrationPaid(details: {
  registrationId: string
  checkoutSessionId?: string | null
  paymentIntentId?: string | null
  amountCents?: number | null
  currency?: string | null
}): Promise<Registration | null> {
  const db = getDatabase()
  const client = await db.pool.connect()

  try {
    await client.query('BEGIN')

    // A lapsed hold that gets paid anyway may have been superseded by a newer
    // attempt from the same person. Retire that attempt so only one seat is held.
    await client.query(
      `UPDATE course_registrations r
          SET status = 'CANCELLED', hold_expires_at = NULL, updated_at = NOW()
         FROM course_registrations target
        WHERE target.id = $1
          AND r.cohort_id = target.cohort_id
          AND LOWER(r.email) = LOWER(target.email)
          AND r.id <> target.id
          AND r.status = 'PENDING'`,
      [details.registrationId],
    )

    const rows = await client.query(
      `UPDATE course_registrations
          SET status = 'PAID',
              paid_at = COALESCE(paid_at, NOW()),
              hold_expires_at = NULL,
              stripe_checkout_session_id = COALESCE($2, stripe_checkout_session_id),
              stripe_payment_intent_id = COALESCE($3, stripe_payment_intent_id),
              amount_cents = COALESCE($4, amount_cents),
              currency = COALESCE($5, currency),
              updated_at = NOW()
        WHERE id = $1
          AND status <> 'PAID'
      RETURNING *`,
      [
        details.registrationId,
        details.checkoutSessionId ?? null,
        details.paymentIntentId ?? null,
        details.amountCents ?? null,
        details.currency ?? null,
      ],
    )

    await client.query('COMMIT')
    return rows.rows[0] ?? null
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}
