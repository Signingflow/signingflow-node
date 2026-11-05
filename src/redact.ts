import type { FieldViolation } from "./errors.js"

const SECRET_KEY = /df_sk_[A-Za-z0-9_-]+/g
const BEARER = /Bearer\s+\S+/gi
const SIGNED_QUERY = /([?&](?:X-Goog-Signature|Signature|sig|token)=)[^&\s"]+/gi

export function redact(value: string): string {
  return value.replace(SECRET_KEY, "df_sk_redacted").replace(BEARER, "Bearer [redacted]").replace(SIGNED_QUERY, "$1[redacted]")
}

export function redactMessage(value: string, limit = 500): string {
  const cleaned = redact(value)
  return cleaned.length > limit ? `${cleaned.slice(0, limit)}…` : cleaned
}

export function redactViolations(list: FieldViolation[] | undefined): FieldViolation[] | undefined {
  if (!list) return undefined
  return list.map((item) => ({ field: redactMessage(item.field), description: redactMessage(item.description) }))
}
