import { SigningflowInvalidRequestError } from "./errors.js"

const ENVELOPE = /^envelopes\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TEMPLATE = /^templates\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EMAIL = /^[^\s@]+@[^\s@]+$/
export interface Recipient {
  name: string
  email: string
}

export interface Envelope {
  name?: string
  uid?: string
  display_name?: string
  displayName?: string
  description?: string
  progress_status?: string
  progressStatus?: string
  state?: string
  condition?: string
  progress?: { state?: string }
  sent_time?: string
  sentTime?: string
  documents?: Array<Record<string, unknown>>
  compliance?: { profile?: string }
}

export function requireEnvelopeName(name: string): string {
  const trimmed = name.trim()
  if (!ENVELOPE.test(trimmed)) {
    throw new SigningflowInvalidRequestError("envelope must look like envelopes/{id}.")
  }
  return trimmed
}

export function requireTemplateName(name: string): string {
  const trimmed = name.trim()
  if (!TEMPLATE.test(trimmed)) {
    throw new SigningflowInvalidRequestError("template must look like templates/{id}.")
  }
  return trimmed
}

export function cleanRecipients(recipients: Recipient[] | undefined): Recipient[] {
  const people = (recipients ?? []).map((person) => ({ name: person.name.trim(), email: person.email.trim() }))
  if (people.length === 0 || people.some((person) => !person.name || !EMAIL.test(person.email))) {
    throw new SigningflowInvalidRequestError("Each recipient needs a name and an email.")
  }
  return people
}

export function envelopeNameOf(body: unknown): string {
  const record = asRecord(body)
  if (!record) return ""
  const nested = asRecord(record.envelope)
  const name = text(nested?.name) || text(record.name)
  if (name.startsWith("envelopes/")) return name
  const uid = text(nested?.uid) || text(record.uid)
  return uid ? `envelopes/${uid}` : ""
}

export function unwrapEnvelope(body: unknown): Envelope {
  const record = asRecord(body)
  if (!record) return {}
  const nested = asRecord(record.envelope)
  return (nested ?? record) as Envelope
}

export function envelopeState(envelope: Envelope): string {
  const progress = asRecord(envelope.progress)
  const fromProgress = text(progress?.state)
  if (fromProgress) return fromProgress
  return text(envelope.progress_status) || text(envelope.progressStatus) || text(envelope.state) || text(envelope.condition)
}

export function sentMillis(envelope: Envelope): number | undefined {
  return timeOf(envelope.sent_time) ?? timeOf(envelope.sentTime)
}

function timeOf(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

export function text(value: unknown): string {
  return typeof value === "string" ? value : ""
}
