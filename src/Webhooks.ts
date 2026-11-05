import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { SigningflowInvalidRequestError, SigningflowSignatureVerificationError } from "./errors.js"

export interface ConstructEventOptions {
  previousSecret?: string
  previousSignature?: string
}

export interface WebhookConstructedEvent {
  payload: unknown
  bodySha256: string
}

export function constructEvent(payload: unknown, signature: string, secret: string, options: ConstructEventOptions = {}): WebhookConstructedEvent {
  const body = rawBytes(payload)
  if (!secret) throw new SigningflowSignatureVerificationError("Webhook secret is required.")
  const current = Boolean(signature) && safeEqual(signature, mac(secret, body))
  const previous = Boolean(options.previousSecret && options.previousSignature) && safeEqual(options.previousSignature ?? "", mac(options.previousSecret ?? "", body))
  if (!current && !previous) throw new SigningflowSignatureVerificationError("Webhook signature did not match.")
  try {
    return { payload: JSON.parse(body.toString("utf8")) as unknown, bodySha256: createHash("sha256").update(body).digest("hex") }
  } catch {
    throw new SigningflowInvalidRequestError("The webhook body is not JSON.")
  }
}

export class Webhooks {
  constructEvent(payload: unknown, signature: string, secret: string, options?: ConstructEventOptions): WebhookConstructedEvent {
    return constructEvent(payload, signature, secret, options)
  }
}

function rawBytes(payload: unknown): Buffer {
  if (typeof payload === "string") return Buffer.from(payload)
  if (Buffer.isBuffer(payload)) return Buffer.from(payload)
  if (payload instanceof Uint8Array) return Buffer.from(payload)
  throw new SigningflowSignatureVerificationError("Pass the raw request body.")
}

function mac(secret: string, body: Buffer): string {
  return createHmac("sha256", secret).update(body).digest("hex")
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left.toLowerCase())
  const b = Buffer.from(right.toLowerCase())
  if (a.length !== b.length) {
    timingSafeEqual(a, a)
    return false
  }
  return timingSafeEqual(a, b)
}
