import type { Config } from '@netlify/functions'
import { isRegistrationId, readAvailability, readRegistrationStatus } from '../lib/course.mjs'

export default async (req: Request) => {
  const registrationId = new URL(req.url).searchParams.get('registration')

  try {
    const availability = await readAvailability()
    if (!availability) {
      return Response.json({ message: 'Course cohort is not configured.' }, { status: 503 })
    }

    const registrationStatus = isRegistrationId(registrationId)
      ? await readRegistrationStatus(registrationId)
      : null

    return Response.json(
      {
        ...availability,
        paymentConfigured: isPaymentConfigured(),
        registrationStatus,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (error) {
    console.error('Failed to read course availability', error)
    return Response.json({ message: 'Could not read course availability.' }, { status: 500 })
  }
}

function isPaymentConfigured() {
  return Boolean(Netlify.env.get('STRIPE_SECRET_KEY') || Netlify.env.get('PUBLIC_STRIPE_PAYMENT_LINK'))
}

export const config: Config = {
  path: '/api/course/availability',
  method: 'GET',
}
