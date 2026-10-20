/**
 * Next.js App Router — drop these two files into your app:
 *
 *   app/api/envelopes/route.ts        → the POST /envelopes dispatcher
 *   app/api/signify-webhook/route.ts  → the webhook receiver
 *
 * This file bundles both for brevity. In production, split them into
 * their actual paths — the imports from signify-starter stay the same.
 *
 * NOTE: this file is intentionally excluded from the starter's `pnpm
 * typecheck` because `next` is not a dependency here. In your Next.js
 * project (where you drop these snippets), `next/server` resolves
 * normally.
 */

import { NextResponse, type NextRequest } from 'next/server'
import { SignifyClient, SignifyError } from '../src/signify-client.ts'
import {
  verifyWebhook,
  WebhookVerificationError,
  type SignifyWebhookEvent,
} from '../src/webhook-handler.ts'

// node runtime: webhook-handler uses node:crypto
export const runtime = 'nodejs'

const signify = new SignifyClient({
  baseUrl: process.env.SIGNIFY_API_URL ?? 'https://sign.echtly.de',
  apiKey: process.env.SIGNIFY_API_KEY!,
})

// ─────────────────────────────────────────────────────────────────────
// app/api/envelopes/route.ts
// ─────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const { templateId, recipient, fieldValues } = (await req.json()) as {
      templateId?: string
      recipient?: { name?: string; email?: string }
      fieldValues?: Record<string, string>
    }

    if (!templateId || !recipient?.name || !recipient?.email) {
      return NextResponse.json(
        { error: 'templateId, recipient.name, recipient.email are required' },
        { status: 400 },
      )
    }

    const draft = await signify.useTemplate({
      templateId,
      title: `Signature request: ${recipient.name}`,
      recipients: [
        { name: recipient.name, email: recipient.email, role: 'signer', order: 1 },
      ],
      fieldValues,
    })

    await signify.sendEnvelope(draft.envelopeId)

    return NextResponse.json(
      {
        envelopeId: draft.envelopeId,
        unmatchedFieldValueKeys: draft.unmatchedFieldValueKeys,
      },
      { status: 201 },
    )
  } catch (err) {
    if (err instanceof SignifyError) {
      return NextResponse.json(
        { error: err.code, message: err.message },
        { status: err.status >= 500 ? 502 : err.status },
      )
    }
    throw err
  }
}

// ─────────────────────────────────────────────────────────────────────
// app/api/signify-webhook/route.ts  (would be its own file)
// ─────────────────────────────────────────────────────────────────────

export async function PUT(req: NextRequest) {
  // Illustrative: using PUT here only so this file has one POST + one
  // other verb without collision. In your real split, this is POST
  // in app/api/signify-webhook/route.ts.
  const rawBody = await req.text() // IMPORTANT: raw text, do not parse
  let event: SignifyWebhookEvent
  try {
    event = verifyWebhook({
      secret: process.env.SIGNIFY_WEBHOOK_SECRET!,
      rawBody,
      headers: Object.fromEntries(req.headers.entries()),
    })
  } catch (err) {
    if (err instanceof WebhookVerificationError) {
      return NextResponse.json({ error: err.reason }, { status: 401 })
    }
    throw err
  }

  // Dispatch — your app logic goes here. The event is a typed
  // discriminated union; TypeScript narrows via event.event.
  switch (event.event) {
    case 'envelope_sent':
      // await db.updateLead({ envelopeId: event.data.envelopeId, status: 'sent' })
      break
    case 'recipient_signed':
      // await db.updateLead({ envelopeId: event.data.envelopeId, status: 'signed' })
      break
    case 'envelope_completed':
      // await db.updateLead({ envelopeId: event.data.envelopeId, status: 'completed' })
      break
    case 'recipient_declined':
      // await db.updateLead({ envelopeId: event.data.envelopeId, status: 'declined', reason: event.data.reason })
      break
    case 'envelope_voided':
      // await db.updateLead({ envelopeId: event.data.envelopeId, status: 'voided' })
      break
  }

  return NextResponse.json({ ok: true })
}
