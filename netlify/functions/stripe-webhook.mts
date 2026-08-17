import type { Config } from '@netlify/functions'
import Stripe from 'stripe'
import { isRegistrationId, markRegistrationPaid, releaseSeat } from '../lib/course.mjs'

export default async (req: Request) => {
  const secretKey = Netlify.env.get('STRIPE_SECRET_KEY')
  const webhookSecret = Netlify.env.get('STRIPE_WEBHOOK_SECRET')

  if (!secretKey || !webhookSecret) {
    console.error('Stripe webhook received but STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET are not set')
    return Response.json({ message: 'Stripe webhook is not configured.' }, { status: 503 })
  }

  const signature = req.headers.get('stripe-signature')
  if (!signature) {
    return Response.json({ message: 'Missing Stripe signature.' }, { status: 400 })
  }

  const stripe = new Stripe(secretKey)

  let event: Stripe.Event
  try {
    // Signature verification needs the untouched request body.
    event = await stripe.webhooks.constructEventAsync(await req.text(), signature, webhookSecret)
  } catch (error) {
    console.error('Rejected a Stripe webhook with an invalid signature or payload', error)
    return Response.json({ message: 'Invalid webhook signature or payload.' }, { status: 400 })
  }

  try {
    await handleEvent(event)
  } catch (error) {
    // A non-2xx tells Stripe to retry, which is what we want for transient failures.
    console.error(`Failed to process Stripe event ${event.type}`, error)
    return Response.json({ message: 'Event processing failed.' }, { status: 500 })
  }

  return Response.json({ received: true })
}

async function handleEvent(event: Stripe.Event) {
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const session = event.data.object
      const registrationId = registrationIdFor(session)
      if (!registrationId) return

      // Delayed payment methods complete the session before the money arrives;
      // the seat stays on hold until async_payment_succeeded confirms it.
      if (session.payment_status === 'unpaid') {
        console.log(`Checkout completed pending payment for registration ${registrationId}`)
        return
      }

      const registration = await markRegistrationPaid({
        registrationId,
        checkoutSessionId: session.id,
        paymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : null,
        amountCents: session.amount_total,
        currency: session.currency,
      })

      console.log(
        registration
          ? `Confirmed course registration ${registrationId}`
          : `Course registration ${registrationId} was already confirmed`,
      )
      return
    }

    case 'checkout.session.async_payment_failed': {
      const registrationId = registrationIdFor(event.data.object)
      if (!registrationId) return
      await releaseSeat(registrationId, 'FAILED')
      console.log(`Released the seat for registration ${registrationId} after a failed payment`)
      return
    }

    case 'checkout.session.expired': {
      const registrationId = registrationIdFor(event.data.object)
      if (!registrationId) return
      await releaseSeat(registrationId, 'EXPIRED')
      console.log(`Released the seat for registration ${registrationId} after checkout expired`)
      return
    }

    default:
      console.log(`Ignoring unhandled Stripe event ${event.type}`)
  }
}

function registrationIdFor(session: Stripe.Checkout.Session) {
  const candidate = session.metadata?.registration_id ?? session.client_reference_id
  if (isRegistrationId(candidate)) return candidate

  console.error(`Stripe checkout session ${session.id} has no usable registration reference`)
  return null
}

export const config: Config = {
  path: '/api/stripe/webhook',
  method: 'POST',
}
