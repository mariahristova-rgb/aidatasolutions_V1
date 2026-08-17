import type { Config } from '@netlify/functions'
import Stripe from 'stripe'
import {
  HOLD_MINUTES,
  attachCheckoutSession,
  releaseSeat,
  reserveSeat,
  type Cohort,
  type Registration,
  type RegistrationInput,
} from '../lib/course.mjs'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const PHONE_PATTERN = /^[+()\d\s.-]{6,30}$/
const PAYMENT_METHODS = new Set(['stripe', 'apple-pay'])

export default async (req: Request) => {
  let payload: Record<string, unknown>
  try {
    payload = await req.json()
  } catch {
    return Response.json({ message: 'Expected a JSON body.' }, { status: 400 })
  }

  const input = validate(payload)
  if ('error' in input) {
    return Response.json({ message: input.error }, { status: 400 })
  }

  const secretKey = Netlify.env.get('STRIPE_SECRET_KEY')
  const paymentLink = Netlify.env.get('PUBLIC_STRIPE_PAYMENT_LINK')

  // Checked before a seat is held, so a misconfigured site never blocks places.
  if (!secretKey && !paymentLink) {
    return Response.json(
      {
        message:
          'Online payment is not configured yet. Please contact us at info@aidatasolutions.tech to reserve your place.',
      },
      { status: 503 },
    )
  }

  let reservation
  try {
    reservation = await reserveSeat(input.value)
  } catch (error) {
    console.error('Failed to reserve a course seat', error)
    return Response.json({ message: 'We could not reserve your place. Please try again.' }, { status: 500 })
  }

  if (!reservation.ok) {
    const messages = {
      FULL: 'This cohort is full. Please contact us for the next available course.',
      ALREADY_PAID: 'This email address is already registered for this cohort. Please contact us if you need help.',
      NO_COHORT: 'Course registration is temporarily unavailable. Please try again later.',
    }
    return Response.json(
      { message: messages[reservation.code], seatsAvailable: reservation.seatsAvailable },
      { status: reservation.code === 'NO_COHORT' ? 503 : 409 },
    )
  }

  const { registration, cohort } = reservation

  try {
    const checkoutUrl = secretKey
      ? await createCheckoutSession(secretKey, req, registration, cohort, input.value)
      : buildPaymentLinkUrl(paymentLink as string, registration)

    return Response.json({
      registrationId: registration.id,
      checkoutUrl,
      seatsAvailable: reservation.seatsAvailable,
      holdMinutes: HOLD_MINUTES,
    })
  } catch (error) {
    console.error('Failed to start checkout, releasing the held seat', error)
    await releaseSeat(registration.id, 'CANCELLED').catch((releaseError) =>
      console.error('Failed to release the held seat', releaseError),
    )
    return Response.json(
      { message: 'We could not open secure payment. Please try again in a moment.' },
      { status: 502 },
    )
  }
}

function validate(payload: Record<string, unknown>): { value: RegistrationInput } | { error: string } {
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

  const email = text(payload.email).toLowerCase()
  const firstName = text(payload.firstName)
  const lastName = text(payload.lastName)
  const phone = text(payload.phone)
  const paymentMethod = text(payload.paymentMethod) || 'stripe'

  if (!EMAIL_PATTERN.test(email) || email.length > 254) {
    return { error: 'Please enter a valid email address.' }
  }
  if (!firstName || firstName.length > 100 || !lastName || lastName.length > 100) {
    return { error: 'Please enter your first and last name.' }
  }
  if (!PHONE_PATTERN.test(phone)) {
    return { error: 'Please enter a valid phone number.' }
  }

  return {
    value: {
      email,
      firstName,
      lastName,
      phone,
      paymentMethod: PAYMENT_METHODS.has(paymentMethod) ? paymentMethod : 'stripe',
    },
  }
}

function returnUrls(req: Request, registrationId: string) {
  const origin = new URL(req.url).origin
  return {
    success: `${origin}/course-program/?payment=success&registration=${registrationId}`,
    cancel: `${origin}/course-program/?payment=cancelled&registration=${registrationId}#register`,
  }
}

async function createCheckoutSession(
  secretKey: string,
  req: Request,
  registration: Registration,
  cohort: Cohort,
  input: RegistrationInput,
) {
  const stripe = new Stripe(secretKey)
  const priceId = Netlify.env.get('STRIPE_PRICE_ID')
  const urls = returnUrls(req, registration.id)

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    client_reference_id: registration.id,
    customer_email: input.email,
    // The hold and the Checkout Session lapse together.
    expires_at: Math.floor(Date.now() / 1000) + HOLD_MINUTES * 60,
    line_items: [
      priceId
        ? { price: priceId, quantity: 1 }
        : {
            quantity: 1,
            price_data: {
              currency: cohort.currency,
              unit_amount: cohort.price_cents,
              product_data: {
                name: cohort.title,
                description: `Live online cohort starting ${cohort.starts_on ?? 'soon'}`,
              },
            },
          },
    ],
    metadata: {
      registration_id: registration.id,
      cohort_slug: cohort.slug,
      first_name: input.firstName,
      last_name: input.lastName,
      phone: input.phone,
      preferred_payment_method: input.paymentMethod ?? 'stripe',
    },
    success_url: urls.success,
    cancel_url: urls.cancel,
  })

  if (!session.url) {
    throw new Error('Stripe did not return a Checkout URL')
  }

  await attachCheckoutSession(registration.id, session.id)
  return session.url
}

/**
 * Fallback for sites configured with a Stripe Payment Link instead of a secret
 * key. `client_reference_id` is what lets the webhook match the payment back to
 * the reserved seat.
 */
function buildPaymentLinkUrl(paymentLink: string, registration: Registration) {
  const url = new URL(paymentLink)
  url.searchParams.set('client_reference_id', registration.id)
  url.searchParams.set('prefilled_email', registration.email)
  return url.toString()
}

export const config: Config = {
  path: '/api/course/register',
  method: 'POST',
}
