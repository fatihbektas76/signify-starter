# signify-starter

Reference implementation for integrating **[Signify](https://sign.echtly.de)** (the Echtly e-signature API) into your own backend. Framework-agnostic TypeScript client + webhook handler + runnable Express/Next.js examples + end-to-end smoke test.

Goal: **clone, set three env vars, send your first envelope in under 15 minutes.**

---

## What you get

| File | Purpose |
|---|---|
| `src/signify-client.ts` | REST client. `useTemplate`, `sendEnvelope`, `remindEnvelope`, `voidEnvelope`, `trashEnvelope`, `toggleFavorite`. Zero runtime deps. |
| `src/webhook-handler.ts` | HMAC-SHA256 verifier + typed discriminated union of all webhook events. |
| `examples/express-server.ts` | Minimal Express server: `POST /envelopes`, `POST /webhook/signify`, `GET /envelopes/:id`. |
| `examples/nextjs-route.ts` | Same thing for Next.js App Router. Drop into `app/api/*/route.ts`. |
| `scripts/smoke-test.ts` | End-to-end lifecycle check against a live Signify instance. |

No framework lock-in: both `src/` files have zero dependencies beyond Node 20+ built-ins (`fetch`, `node:crypto`). Copy them into any Node project — Express, Fastify, Hono, Nest, Next.js, Bun, Deno.

---

## Architecture (two-way integration)

```
                   ┌────────────────────────┐
                   │   Your backend         │
   lead save ────► │                        │
                   │ 1. SignifyClient.use   │────► POST /api/templates/:id/use ─┐
                   │    Template + send     │                                    │
                   │                        │                                    ▼
                   │                        │                           ┌────────────────┐
                   │                        │                           │    Signify     │
                   │                        │                           │ sign.echtly.de │
                   │ 3. Update your DB,     │                           │                │
                   │    show status to user │ ◄──── HMAC-signed POST ───┤ 2. Emails,     │
                   │                        │       /webhook/signify    │    signs,      │
                   │ ◄── verifyWebhook() ◄──┤                           │    completes   │
                   └────────────────────────┘                           └────────────────┘
```

**Outbound (REST):** you call Signify to create and manage envelopes.
**Inbound (webhook):** Signify calls you back when things happen.

---

## Quickstart

### 1. Clone and install

```bash
git clone https://github.com/fatihbektas76/signify-starter.git
cd signify-starter
pnpm install   # or: npm install / yarn / bun install
```

### 2. Get credentials from Signify

Log into [sign.echtly.de](https://sign.echtly.de), then:

- **API key:** Developers → API Keys → Create. Scope: `write`. Format: `sk_...`.
- **Webhook secret:** Developers → Webhooks → Create. URL = your public URL + `/webhook/signify`. Events = `*` (or pick specific). Copy the generated secret.
- **A template:** Templates → New → upload a PDF → place fields → save. Copy the template ID from the URL.

### 3. Configure

```bash
cp .env.example .env
# Edit .env — fill in SIGNIFY_API_KEY, SIGNIFY_WEBHOOK_SECRET,
# and (for the smoke test) SIGNIFY_SMOKE_TEMPLATE_ID.
```

### 4. Run the smoke test

```bash
pnpm smoke
```

Expected output:

```
→ useTemplate (create draft)              OK   envelopeId=0aaee2ee-…
→ getEnvelope (status=draft)              OK   status=draft
→ sendEnvelope                            OK   status=sent
→ toggleFavorite (on)                     OK   isFavorite=true
→ toggleFavorite (off)                    OK   isFavorite=false
→ remindEnvelope                          OK
→ voidEnvelope                            OK
→ trashEnvelope                           OK
→ restoreEnvelope                         OK
→ trashEnvelope (final)                   OK

10/10 passed, 0 failed
```

If any step fails, the error (HTTP code + Signify error code + message) prints alongside.

### 5. Run the example server

```bash
pnpm example:express
```

Then from another terminal:

```bash
curl -X POST http://localhost:4000/envelopes \
  -H 'content-type: application/json' \
  -d '{
    "templateId": "YOUR_TEMPLATE_ID",
    "recipient": { "name": "Alice", "email": "alice@example.com" },
    "fieldValues": { "address": "Main St 1, Berlin" }
  }'
```

You get back `{ "envelopeId": "...", "unmatchedFieldValueKeys": [] }`. Alice receives the signature email. When she signs, your server logs `[signed] <id> by alice@example.com`.

---

## Using the client in your own code

```ts
import { SignifyClient, SignifyError } from './signify-client.ts'

const signify = new SignifyClient({
  baseUrl: 'https://sign.echtly.de',
  apiKey: process.env.SIGNIFY_API_KEY!,
})

try {
  const draft = await signify.useTemplate({
    templateId: 'tpl_...',
    title: 'Service agreement: Max Mustermann',
    recipients: [
      { name: 'Max Mustermann', email: 'max@…', role: 'signer', order: 1 },
    ],
    fieldValues: {
      // keys match template field labels (case-insensitive)
      full_name: 'Max Mustermann',
      address: 'Hauptstraße 1, 10115 Berlin',
    },
  })

  await signify.sendEnvelope(draft.envelopeId)

  // Store draft.envelopeId in your DB so your webhook handler can
  // correlate incoming events back to this record.
  if (draft.unmatchedFieldValueKeys.length > 0) {
    console.warn(
      'Prefill keys without matching template field:',
      draft.unmatchedFieldValueKeys,
    )
  }
} catch (err) {
  if (err instanceof SignifyError) {
    // Signify returned a structured error: err.code, err.message, err.status
    throw new Error(`Signify ${err.status} ${err.code}: ${err.message}`)
  }
  throw err
}
```

### Lifecycle methods

| Method | Purpose |
|---|---|
| `useTemplate({ templateId, title, recipients, fieldValues? })` | Instantiate template as draft. |
| `sendEnvelope(id)` | Send draft (emails go out). |
| `getEnvelope(id)` | Fetch current status. |
| `remindEnvelope(id, recipientId?)` | Nudge pending recipient(s). |
| `voidEnvelope(id, reason)` | Revoke sent envelope. |
| `trashEnvelope(id)` | Soft-delete (reversible). |
| `restoreEnvelope(id)` | Undo trash. |
| `toggleFavorite(id)` | Toggle favorite flag. |

For additional endpoints (teams, bulk operations, stamps, in-person sessions), see the OpenAPI reference at `https://sign.echtly.de/developers/api-reference`.

---

## Receiving webhooks

Signify sends HMAC-SHA256-signed POSTs to your configured URL. The `verifyWebhook` helper validates signature + timestamp + body, returns a typed discriminated union, or throws `WebhookVerificationError`.

```ts
import { verifyWebhook, WebhookVerificationError } from './webhook-handler.ts'

const rawBody = await req.text() // IMPORTANT: raw text, don't JSON.parse first

try {
  const event = verifyWebhook({
    secret: process.env.SIGNIFY_WEBHOOK_SECRET!,
    rawBody,
    headers: Object.fromEntries(req.headers.entries()),
  })

  switch (event.event) {
    case 'envelope_sent':
      // event.data: { envelopeId, title, status, sentAt, recipients[] }
      break
    case 'recipient_signed':
      // event.data: { envelopeId, title, recipient, signedAt, inPerson }
      break
    case 'envelope_completed':
      // event.data: { envelopeId, title, status, completedAt, signers[] }
      break
    case 'recipient_declined':
      // event.data: { envelopeId, title, recipient, reason, declinedAt }
      break
    case 'envelope_voided':
      // event.data: { envelopeId, title, status, reason, voidedAt }
      break
  }

  return new Response(JSON.stringify({ ok: true }), { status: 200 })
} catch (err) {
  if (err instanceof WebhookVerificationError) {
    // err.reason: 'missing_signature_header' | 'signature_mismatch' | …
    return new Response(JSON.stringify({ error: err.reason }), { status: 401 })
  }
  throw err
}
```

### Verification details

- **Signature format:** `x-webhook-signature: t=<unix_ts>,v1=<hex>`
- **Base string for HMAC:** `${timestamp}.${rawBody}`
- **Replay protection:** signatures older than 5 minutes are rejected (configurable via `maxSkewSeconds`).
- **Timing-safe comparison:** uses `crypto.timingSafeEqual`.

### Idempotency

Signify retries non-2xx deliveries with exponential backoff. Your handler must be idempotent:

- Dedupe by `(envelopeId, event, timestamp)` or similar if your DB updates aren't naturally idempotent.
- Don't downgrade state: `envelope_completed` arriving before `envelope_sent` (rare but possible) should not revert status to "sent".
- Return 200 fast — do heavy work (sending Slack notifications, generating reports) in a background queue.

---

## Design notes

### Why framework-agnostic

The two files in `src/` have no dependencies beyond Node 20+ built-ins. You can `cp src/*.ts your-project/lib/signify/` and keep going — no fragile package upgrades, no transitive-dep CVE churn, no "but we're on Bun" surprises.

### Why typed webhook events

A discriminated union on `event.event` lets TypeScript narrow the shape of `event.data`. You get autocomplete, exhaustiveness checking (`default` case triggers compile error if a new event is added and unhandled), and no `as any`.

### Why examples instead of a published package

E-signature integrations are a one-time install, not a daily-updated dep. Pinning to a published package tends to produce stale integrations and migration pain. Copy-paste is honest: when Signify adds a feature, you grab the next version of the two source files, diff, apply.

### What's NOT in here (and when you need it)

- **Rate-limit handling / exponential backoff on outbound requests.** Signify's rate limits are generous (envelope endpoints: 30/min); for high-volume producers, wrap `signify.useTemplate` with your own retry/queue logic.
- **File upload for custom documents.** This starter uses templates (upload-once, reuse-many). For envelopes with user-provided PDFs, use `POST /api/documents` directly.
- **Multi-tenancy helpers.** The client is single-tenant per instance (one API key = one Signify team). If you serve many teams, instantiate one `SignifyClient` per team.
- **Non-signer recipient flows (reviewers, CC).** The example uses `role: 'signer'`. Signify supports `reviewer` (approve/reject) and `cc` (observer) too — same shape, different role.

---

## License

MIT. See [LICENSE](./LICENSE).

Contributions welcome — this is a community reference, not an official SDK. If you find a lifecycle method missing or an event shape wrong, open a PR.
