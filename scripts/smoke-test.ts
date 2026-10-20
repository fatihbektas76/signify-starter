/**
 * End-to-end smoke test — exercises the full envelope lifecycle via
 * SignifyClient against a live Signify instance.
 *
 * What it does:
 *   1. useTemplate   (create draft envelope from a regular template)
 *   2. getEnvelope   (verify it exists with status=draft)
 *   3. sendEnvelope  (status → sent, email goes out)
 *   4. toggleFavorite (on, then off)
 *   5. remindEnvelope (nudge the recipient)
 *   6. voidEnvelope  (reason: smoke-test cleanup)
 *   7. trashEnvelope + restoreEnvelope
 *
 * Required env (see .env.example):
 *   SIGNIFY_API_URL, SIGNIFY_API_KEY, SIGNIFY_SMOKE_TEMPLATE_ID,
 *   SIGNIFY_SMOKE_RECIPIENT_EMAIL
 *
 * Run:
 *   pnpm smoke
 *
 * The envelope is voided + trashed at the end, so your dashboard stays
 * tidy. The recipient will receive one send-email and one void-email —
 * use a mailinator.com address or similar sink.
 */

import { SignifyClient, SignifyError } from '../src/signify-client.ts'

const {
  SIGNIFY_API_URL = 'https://sign.echtly.de',
  SIGNIFY_API_KEY,
  SIGNIFY_SMOKE_TEMPLATE_ID,
  SIGNIFY_SMOKE_RECIPIENT_EMAIL,
} = process.env

if (!SIGNIFY_API_KEY) fail('SIGNIFY_API_KEY env var is required')
if (!SIGNIFY_SMOKE_TEMPLATE_ID) fail('SIGNIFY_SMOKE_TEMPLATE_ID env var is required')
if (!SIGNIFY_SMOKE_RECIPIENT_EMAIL) fail('SIGNIFY_SMOKE_RECIPIENT_EMAIL env var is required')

const signify = new SignifyClient({ baseUrl: SIGNIFY_API_URL, apiKey: SIGNIFY_API_KEY })

const results: Array<{ step: string; ok: boolean; detail?: string }> = []

async function step(label: string, fn: () => Promise<string | void>): Promise<void> {
  process.stdout.write(`→ ${label.padEnd(40)}`)
  try {
    const detail = (await fn()) ?? undefined
    results.push({ step: label, ok: true, detail })
    console.log(`  OK${detail ? '   ' + detail : ''}`)
  } catch (err) {
    const msg = err instanceof SignifyError
      ? `${err.status} ${err.code}: ${err.message}`
      : err instanceof Error
        ? err.message
        : String(err)
    results.push({ step: label, ok: false, detail: msg })
    console.log(`  FAIL ${msg}`)
  }
}

let envelopeId: string | null = null

await step('useTemplate (create draft)', async () => {
  const draft = await signify.useTemplate({
    templateId: SIGNIFY_SMOKE_TEMPLATE_ID,
    title: `SMOKE-TEST ${new Date().toISOString()}`,
    recipients: [
      {
        name: 'Smoke Test',
        email: SIGNIFY_SMOKE_RECIPIENT_EMAIL,
        role: 'signer',
        order: 1,
      },
    ],
    fieldValues: {},
  })
  envelopeId = draft.envelopeId
  return `envelopeId=${envelopeId}`
})

if (!envelopeId) {
  console.error('\nBailing: no envelopeId from useTemplate')
  process.exit(1)
}

await step('getEnvelope (status=draft)', async () => {
  const env = await signify.getEnvelope(envelopeId!)
  if (env.status !== 'draft') throw new Error(`expected draft, got ${env.status}`)
  return `status=${env.status}`
})

await step('sendEnvelope', async () => {
  const env = await signify.sendEnvelope(envelopeId!)
  if (env.status !== 'sent') throw new Error(`expected sent, got ${env.status}`)
  return `status=${env.status}`
})

await step('toggleFavorite (on)', async () => {
  const r = await signify.toggleFavorite(envelopeId!)
  if (!r.isFavorite) throw new Error('expected isFavorite=true')
  return 'isFavorite=true'
})

await step('toggleFavorite (off)', async () => {
  const r = await signify.toggleFavorite(envelopeId!)
  if (r.isFavorite) throw new Error('expected isFavorite=false')
  return 'isFavorite=false'
})

await step('remindEnvelope', async () => {
  await signify.remindEnvelope(envelopeId!)
})

await step('voidEnvelope', async () => {
  await signify.voidEnvelope(envelopeId!, 'smoke-test cleanup')
})

await step('trashEnvelope', async () => {
  await signify.trashEnvelope(envelopeId!)
})

await step('restoreEnvelope', async () => {
  await signify.restoreEnvelope(envelopeId!)
})

await step('trashEnvelope (final)', async () => {
  await signify.trashEnvelope(envelopeId!)
})

const passed = results.filter((r) => r.ok).length
const failed = results.filter((r) => !r.ok).length

console.log(`\n${passed}/${results.length} passed, ${failed} failed`)
console.log(`envelope ${envelopeId} is in trash — delete manually if desired`)

if (failed > 0) process.exit(1)

function fail(msg: string): never {
  console.error(`Error: ${msg}`)
  process.exit(1)
}
