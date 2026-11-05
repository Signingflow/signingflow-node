import type { FieldViolation } from "./errors.js"

export function grpcCode(body: unknown): number | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined
  const code = (body as Record<string, unknown>).code
  return typeof code === "number" ? code : undefined
}

export function serverMessage(body: unknown): string {
  if (typeof body === "string") return body
  if (!body || typeof body !== "object" || Array.isArray(body)) return ""
  const message = (body as Record<string, unknown>).message
  return typeof message === "string" ? message : ""
}

export function traceCodeOf(body: unknown): string | undefined {
  return findMeta(body, "trace_code") || undefined
}

export function resourceNameOf(body: unknown): string | undefined {
  const url = findMeta(body, "resource_url")
  if (url) return url
  const id = findMeta(body, "resource_id")
  return id || undefined
}

export function fieldViolationsOf(body: unknown): FieldViolation[] | undefined {
  const found: FieldViolation[] = []
  walk(body, (record) => {
    const list = record.fieldViolations ?? record.field_violations
    if (!Array.isArray(list)) return
    for (const item of list) {
      if (!item || typeof item !== "object") continue
      const row = item as Record<string, unknown>
      const field = text(row.field)
      const description = text(row.description)
      if (field || description) found.push({ field, description })
    }
  })
  return found.length > 0 ? found : undefined
}

export function mentionsIdempotency(body: unknown): boolean {
  const encoded = JSON.stringify(body ?? "").toLowerCase()
  return encoded.includes("idempotency")
}

function findMeta(body: unknown, key: string): string {
  let found = ""
  walk(body, (record) => {
    if (found) return
    const metadata = record.metadata
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return
    const value = (metadata as Record<string, unknown>)[key]
    if (typeof value === "string" && value) found = value
  })
  return found
}

function walk(value: unknown, visit: (record: Record<string, unknown>) => void) {
  if (!value || typeof value !== "object") return
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit)
    return
  }
  const record = value as Record<string, unknown>
  visit(record)
  for (const child of Object.values(record)) walk(child, visit)
}

function text(value: unknown): string {
  return typeof value === "string" ? value : ""
}
