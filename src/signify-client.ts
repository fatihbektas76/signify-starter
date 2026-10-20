/**
 * Signify REST client — framework-agnostic, zero runtime dependencies.
 *
 * Covers the full envelope lifecycle a third-party integrator typically
 * needs: instantiate a template, send, remind, void, trash. For the
 * complete API surface (teams, templates CRUD, bulk, stamps, …) see the
 * OpenAPI reference at https://sign.echtly.de/developers/api-reference.
 *
 * All methods return the response's `data` payload (unwrapped from
 * Signify's standard `{data, error}` envelope). Non-2xx responses throw
 * a SignifyError with the parsed error code + message.
 */

export interface SignifyClientConfig {
  /** Signify API base URL, e.g. https://sign.echtly.de */
  baseUrl: string
  /** Bearer API key (format: sk_...) from /developers/api-keys */
  apiKey: string
  /** Request timeout in ms. Defaults to 30s. */
  timeoutMs?: number
  /** Custom fetch implementation (for tests, custom proxies, etc.) */
  fetch?: typeof fetch
}

export interface Recipient {
  name: string
  email: string
  role: 'signer' | 'reviewer' | 'cc'
  order: number
  phone?: string
}

export interface UseTemplateInput {
  /** Regular Template ID from Signify dashboard */
  templateId: string
  /** Envelope title shown in dashboard + email subject */
  title: string
  recipients: Recipient[]
  /** Prefill values. Keys = template field labels (case-insensitive). */
  fieldValues?: Record<string, string>
  /** Optional custom message, overrides template default */
  message?: string
}

export interface UseTemplateResult {
  envelopeId: string
  /** Keys from fieldValues that didn't match any template field.
   *  Diagnostic — the envelope was still created successfully. */
  unmatchedFieldValueKeys: string[]
}

export interface EnvelopeSummary {
  id: string
  teamId: string
  title: string
  status: 'draft' | 'sent' | 'partial' | 'completed' | 'declined' | 'expired' | 'voided' | 'sealing'
  sentAt: string | null
  completedAt: string | null
  signatureLevel: 'ees' | 'fes' | 'qes'
}

export class SignifyError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message)
    this.name = 'SignifyError'
  }
}

export class SignifyClient {
  readonly #baseUrl: string
  readonly #apiKey: string
  readonly #timeoutMs: number
  readonly #fetch: typeof fetch

  constructor(config: SignifyClientConfig) {
    if (!config.baseUrl) throw new Error('SignifyClient: baseUrl is required')
    if (!config.apiKey) throw new Error('SignifyClient: apiKey is required')
    if (!config.apiKey.startsWith('sk_')) {
      throw new Error('SignifyClient: apiKey must start with "sk_"')
    }
    this.#baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.#apiKey = config.apiKey
    this.#timeoutMs = config.timeoutMs ?? 30_000
    this.#fetch = config.fetch ?? fetch
  }

  async #request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.#baseUrl}${path}`
    const res = await this.#fetch(url, {
      method,
      headers: {
        'Authorization': `Bearer ${this.#apiKey}`,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.#timeoutMs),
    })

    let json: unknown = null
    try {
      json = await res.json()
    } catch {
      // Non-JSON response — fall through to error handling
    }

    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error
      throw new SignifyError(
        err?.code ?? 'HTTP_ERROR',
        err?.message ?? `Signify ${method} ${path} returned ${res.status}`,
        res.status,
        err?.details,
      )
    }

    return (json as { data: T }).data
  }

  // ───────────────────────────── Templates ────────────────────────

  /**
   * Instantiate a Regular Template as a draft envelope. Fields with
   * matching labels in `fieldValues` are prefilled; signature fields
   * remain empty for the recipient to sign.
   *
   * Note: this creates the envelope in `draft` status. Call `sendEnvelope`
   * afterwards to actually deliver it to recipients.
   */
  useTemplate(input: UseTemplateInput): Promise<UseTemplateResult> {
    return this.#request('POST', `/api/templates/${encodeURIComponent(input.templateId)}/use`, {
      title: input.title,
      recipients: input.recipients,
      fieldValues: input.fieldValues ?? {},
      message: input.message,
    })
  }

  // ───────────────────────────── Envelopes ────────────────────────

  /** Fetch envelope metadata (status, timestamps, recipients). */
  getEnvelope(envelopeId: string): Promise<EnvelopeSummary> {
    return this.#request('GET', `/api/envelopes/${encodeURIComponent(envelopeId)}`)
  }

  /**
   * Send a draft envelope. Recipients receive emails, envelope status
   * flips to `sent`. Returns the updated envelope.
   */
  sendEnvelope(envelopeId: string): Promise<EnvelopeSummary> {
    return this.#request('POST', `/api/envelopes/${encodeURIComponent(envelopeId)}/send`, {})
  }

  /**
   * Send a reminder email to recipients who haven't signed yet.
   * @param recipientId Optional — if set, remind only this recipient.
   *                    If omitted, reminds all pending recipients.
   */
  remindEnvelope(envelopeId: string, recipientId?: string): Promise<unknown> {
    return this.#request('POST', `/api/envelopes/${encodeURIComponent(envelopeId)}/remind`, {
      recipient_id: recipientId,
    })
  }

  /**
   * Void (revoke) a sent envelope. Status flips to `voided`, all
   * recipients receive a notification. Reason is required for audit.
   */
  voidEnvelope(envelopeId: string, reason: string): Promise<unknown> {
    return this.#request('POST', `/api/envelopes/${encodeURIComponent(envelopeId)}/void`, {
      reason,
    })
  }

  /** Soft-delete: move envelope to trash. Reversible with `restoreEnvelope`. */
  trashEnvelope(envelopeId: string): Promise<unknown> {
    return this.#request('POST', `/api/envelopes/${encodeURIComponent(envelopeId)}/trash`)
  }

  /** Restore an envelope from trash. */
  restoreEnvelope(envelopeId: string): Promise<unknown> {
    return this.#request('PATCH', `/api/envelopes/${encodeURIComponent(envelopeId)}/trash`)
  }

  /** Toggle the envelope's favorite flag. */
  toggleFavorite(envelopeId: string): Promise<{ isFavorite: boolean }> {
    return this.#request('POST', `/api/envelopes/${encodeURIComponent(envelopeId)}/favorite`)
  }
}
