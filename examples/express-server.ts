/**
 * Runnable Express example — the smallest possible real integration.
 *
 *   POST /envelopes       → create + send an envelope from a template
 *   POST /webhook/signify → receive status updates from Signify
 *   GET  /envelopes/:id   → look up envelope status
 *
 * Start:
 *   pnpm install && pnpm example:express
 *
 * Then POST to http://localhost:4000/envelopes with your template-id,
 * recipient email + prefill. Register the public URL of
 * /webhook/signify in the Signify dashboard under Developers → Webhooks.
 */

import express from 'express'
import { SignifyClient, SignifyError } from '../src/signify-client.ts'
import {
  verifyWebhook,
  WebhookVerificationError,
  type SignifyWebhookEvent,
} from '../src/webhook-handler.ts'

const SIGNIFY_API_URL = process.env.SIGNIFY_API_URL ?? 'https://sign.echtly.de'
const SIGNIFY_API_KEY = process.env.SIGNIFY_API_KEY
const SIGNIFY_WEBHOOK_SECRET = process.env.SIGNIFY_WEBHOOK_SECRET
const PORT = Number(process.env.PORT ?? 4000)

if (!SIGNIFY_API_KEY || !SIGNIFY_WEBHOOK_SECRET) {
  console.error('Missing SIGNIFY_API_KEY or SIGNIFY_WEBHOOK_SECRET env vars')
  process.exit(1)
}

const signify = new SignifyClient({
  baseUrl: SIGNIFY_API_URL,
  apiKey: SIGNIFY_API_KEY,
})

const app = express()

// Webhook route MUST read the raw body for HMAC verification. Mount this
// BEFORE express.json() or use its own raw-body parser.
app.post(
  '/webhook/signify',
  express.raw({ type: 'application/json', limit: '1mb' }),
  (req, res) => {
    const rawBody = (req.body as Buffer).toString('utf8')
    let event: SignifyWebhookEvent
    try {
      event = verifyWebhook({
        secret: SIGNIFY_WEBHOOK_SECRET!,
        rawBody,
        headers: req.headers as Record<string, string | string[] | undefined>,
      })
    } catch (err) {
      if (err instanceof WebhookVerificationError) {
        console.warn(`[webhook] rejected: ${err.reason} — ${err.message}`)
        res.status(401).json({ error: err.reason })
        return
      }
      throw err
    }

    // At this point `event` is a verified, typed discriminated union.
    // Switch on event.event for type-narrowing.
    switch (event.event) {
      case 'envelope_sent':
        console.log(`[sent]      ${event.data.envelopeId} "${event.data.title}" to ${event.data.recipients.length} recipient(s)`)
        break
      case 'recipient_signed':
        console.log(`[signed]    ${event.data.envelopeId} by ${event.data.recipient.email}${event.data.inPerson ? ' (in-person)' : ''}`)
        break
      case 'envelope_completed':
        console.log(`[completed] ${event.data.envelopeId} at ${event.data.completedAt} (${event.data.signers.length} signer(s))`)
        break
      case 'recipient_declined':
        console.log(`[declined]  ${event.data.envelopeId} by ${event.data.recipient.email}: "${event.data.reason}"`)
        break
      case 'envelope_voided':
        console.log(`[voided]    ${event.data.envelopeId}: "${event.data.reason}"`)
        break
    }

    // 200 fast — Signify retries non-2xx responses with exponential backoff.
    res.status(200).json({ ok: true })
  },
)

// All other routes can use the standard JSON body parser.
app.use(express.json())

/**
 * Dispatch an envelope. Body shape:
 *   {
 *     "templateId": "uuid",
 *     "recipient": { "name": "Max", "email": "max@..." },
 *     "fieldValues": { "name": "Max", "address": "..." }
 *   }
 */
app.post('/envelopes', async (req, res) => {
  try {
    const { templateId, recipient, fieldValues } = req.body as {
      templateId?: string
      recipient?: { name?: string; email?: string }
      fieldValues?: Record<string, string>
    }

    if (!templateId || !recipient?.name || !recipient?.email) {
      res.status(400).json({ error: 'templateId, recipient.name, recipient.email are required' })
      return
    }

    const draft = await signify.useTemplate({
      templateId,
      title: `Signature request: ${recipient.name}`,
      recipients: [{ name: recipient.name, email: recipient.email, role: 'signer', order: 1 }],
      fieldValues,
    })

    await signify.sendEnvelope(draft.envelopeId)

    res.status(201).json({
      envelopeId: draft.envelopeId,
      unmatchedFieldValueKeys: draft.unmatchedFieldValueKeys,
    })
  } catch (err) {
    if (err instanceof SignifyError) {
      console.error(`[dispatch] Signify error ${err.status} ${err.code}: ${err.message}`)
      res.status(err.status >= 500 ? 502 : err.status).json({ error: err.code, message: err.message })
      return
    }
    throw err
  }
})

app.get('/envelopes/:id', async (req, res) => {
  try {
    const envelope = await signify.getEnvelope(req.params.id)
    res.json(envelope)
  } catch (err) {
    if (err instanceof SignifyError) {
      res.status(err.status).json({ error: err.code, message: err.message })
      return
    }
    throw err
  }
})

app.listen(PORT, () => {
  console.log(`signify-starter example listening on http://localhost:${PORT}`)
  console.log(`  POST /envelopes       (dispatch via Signify REST)`)
  console.log(`  POST /webhook/signify (receive status updates)`)
})
