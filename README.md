# AI Data Solutions

Astro site for aidatasolutions.tech, deployed on Netlify.

## Course registration and payment

The course page (`/course-program`) sells a fixed number of places in a cohort. The
ten-place limit and the payment state are held in Netlify Database (Postgres), not in
the browser, so the limit holds across visitors, devices and page reloads.

| Piece | Location |
| --- | --- |
| Schema and seeded cohort | `netlify/database/migrations/` |
| Seat reservation logic | `netlify/lib/course.mts` |
| `GET /api/course/availability` | `netlify/functions/course-availability.mts` |
| `POST /api/course/register` | `netlify/functions/course-register.mts` |
| `POST /api/stripe/webhook` | `netlify/functions/stripe-webhook.mts` |

Flow: registering reserves one seat as a `PENDING` row with a 60 minute hold, then
redirects to Stripe Checkout. The seat only becomes `PAID` when Stripe sends a
signature-verified `checkout.session.completed` event. Abandoned, expired and failed
checkouts release the seat again, so unpaid attempts cannot exhaust the cohort.

### Environment variables

Set these as environment variables for the site (Netlify UI, or `netlify env:set`).
Never commit them.

| Variable | Scope | Purpose |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | Secret, runtime | Creates Checkout Sessions and verifies webhooks. |
| `STRIPE_WEBHOOK_SECRET` | Secret, runtime | Signing secret of the webhook endpoint. |
| `STRIPE_PRICE_ID` | Optional | Use an existing Stripe Price instead of the cohort price in the database. |
| `PUBLIC_STRIPE_PAYMENT_LINK` | Optional fallback | Used only when `STRIPE_SECRET_KEY` is absent. |

In the Stripe dashboard, point a webhook endpoint at
`https://<your-domain>/api/stripe/webhook` and subscribe to
`checkout.session.completed`, `checkout.session.expired`,
`checkout.session.async_payment_succeeded` and `checkout.session.async_payment_failed`.

Changing the cohort price, start date or number of places is a data change: add a new
migration in `netlify/database/migrations/` that updates the `course_cohorts` row.

## Local development

```bash
npm install
netlify dev --port 8889
```

`netlify dev` serves the Astro site together with the functions and connects to the
database branch for the current context.
