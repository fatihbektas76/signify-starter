/**
 * Signify webhook verification + typed event parsing.
 *
 * Signify delivers status updates (envelope_sent, recipient_signed,
 * envelope_completed, recipient_declined, envelope_voided) via
 * HMAC-SHA256-signed POST. This module gives you one function that
 * takes the raw request bytes + headers and returns a typed, verified
 * event — or throws a WebhookVerificationError.
 *
 * Framework-agnostic: give it a string body (not JSON.parsed!) and the
 * header map. Works with Express req.rawBody, Next.js await req.text(),
 * Fastify request.rawBody, Bun's await req.text(), etc.
 *
 * Signature format: header `x-webhook-signature: t=<unix_ts>,v1=<hex>`
 * Base string for HMAC: `${timestamp}.${rawBody}`
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

/** Fields present on every Signify webhook event. */
interface BaseEvent {
  timestamp: string
}

export interface EnvelopeSentEvent extends BaseEvent {
  event: 'envelope_sent'
  data: {
    envelopeId: string
    title: string
    status: 'sent'
    sentAt: string
    recipients: Array<{
      id: string
      name: string
      email: string
      role: 'signer' | 'reviewer' | 'cc'
      order: number
    }>
  }
}

export interface RecipientSignedEvent extends BaseEvent {
  event: 'recipient_signed'
  data: {
    envelopeId: string
    title: string
    recipient: {
      id: string
      name: string
      email: string
      role: string
      order: number
    }
    signedAt: string
    inPerson: boolean
  }
}

export interface EnvelopeCompletedEvent extends BaseEvent {
  event: 'envelope_completed'
  data: {
    envelopeId: string
    title: string
    status: 'completed'
    completedAt: string
    signers: Array<{
      id: string
      name: string
      email: string
      signedAt: string | null
    }>
  }
}

export interface RecipientDeclinedEvent extends BaseEvent {
  event: 'recipient_declined'
  data: {
    envelopeId: string
    title: string
    recipient: {
      id: string
      name: string
      email: string
      role: string
      order: number
    }
    reason: string
    declinedAt: string
  }
}

export interface EnvelopeVoidedEvent extends BaseEvent {
  event: 'envelope_voided'
  data: {
    envelopeId: string
    title: string
    status: 'voided'
    reason: string
    voidedAt: string
  }
}

/** Discriminated union — switch on `event.event` for type-narrowing. */
export type SignifyWebhookEvent =
  | EnvelopeSentEvent
  | RecipientSignedEvent
  | EnvelopeCompletedEvent
  | RecipientDeclinedEvent
  | EnvelopeVoidedEvent

export class WebhookVerificationError extends Error {
  constructor(
    public readonly reason:
      | 'missing_signature_header'
      | 'malformed_signature_header'
      | 'timestamp_out_of_range'
      | 'signature_mismatch'
      | 'invalid_json',
    message: string,
  ) {
    super(message)
    this.name = 'WebhookVerificationError'
  }
}

export interface VerifyOptions {
  /** The shared secret from Signify dashboard. */
  secret: string
  /** The raw request body as a string (do NOT JSON.parse first). */
  rawBody: string
  /** Request headers as a plain object (keys lowercased or as-is). */
  headers: Record<string, string | string[] | undefined>
  /** Replay protection: max accepted timestamp skew in seconds. Default: 300 (5 min). */
  maxSkewSeconds?: number
  /** Current unix timestamp — override only for tests. */
  nowSeconds?: () => number
}

function headerLookup(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const lower = name.toLowerCase()
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) {
      if (Array.isArray(v)) return v[0] ?? null
      return v ?? null
    }
  }
  return null
}

function parseSignatureHeader(h: string): { ts: number; v1: string } | null {
  const parts = h.split(',').map((p) => p.trim())
  let ts: number | undefined
  let v1: string | undefined
  for (const part of parts) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    const k = part.slice(0, idx)
    const value = part.slice(idx + 1)
    if (k === 't') ts = Number(value)
    if (k === 'v1') v1 = value
  }
  if (ts === undefined || Number.isNaN(ts) || !v1) return null
  return { ts, v1 }
}

function timingSafeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  const bufA = Buffer.from(a, 'hex')
  const bufB = Buffer.from(b, 'hex')
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/**
 * Verify a Signify webhook request and return the parsed event.
 * Throws WebhookVerificationError on any failure.
 */
export function verifyWebhook(opts: VerifyOptions): SignifyWebhookEvent {
  const sig = headerLookup(opts.headers, 'x-webhook-signature')
  if (!sig) {
    throw new WebhookVerificationError(
      'missing_signature_header',
      'Required header "x-webhook-signature" is missing',
    )
  }

  const parsed = parseSignatureHeader(sig)
  if (!parsed) {
    throw new WebhookVerificationError(
      'malformed_signature_header',
      `Could not parse signature header: ${sig}`,
    )
  }

  const now = opts.nowSeconds ? opts.nowSeconds() : Math.floor(Date.now() / 1000)
  const maxSkew = opts.maxSkewSeconds ?? 300
  if (Math.abs(now - parsed.ts) > maxSkew) {
    throw new WebhookVerificationError(
      'timestamp_out_of_range',
      `Timestamp ${parsed.ts} is more than ${maxSkew}s away from ${now}`,
    )
  }

  const expected = createHmac('sha256', opts.secret)
    .update(`${parsed.ts}.${opts.rawBody}`)
    .digest('hex')

  if (!timingSafeHexEqual(expected, parsed.v1)) {
    throw new WebhookVerificationError('signature_mismatch', 'HMAC signature does not match')
  }

  let event: SignifyWebhookEvent
  try {
    event = JSON.parse(opts.rawBody) as SignifyWebhookEvent
  } catch {
    throw new WebhookVerificationError('invalid_json', 'Request body is not valid JSON')
  }

  return event
}
