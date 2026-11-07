import { randomUUID } from "node:crypto"
import type { OperationSpec } from "./allowlist.js"
import type { ResolvedConfig } from "./config.js"
import {
  SigningflowAPIError,
  SigningflowAuthenticationError,
  SigningflowConnectionError,
  SigningflowError,
  SigningflowIdempotencyError,
  SigningflowInvalidRequestError,
  SigningflowPermissionError,
  SigningflowRateLimitError,
  type ErrorFields,
} from "./errors.js"
import { fillPath, queryContainsSecret, resolveUrl } from "./path.js"
import { redactMessage, redactViolations } from "./redact.js"
import { retryDelayMs, sleep } from "./net/retry.js"
import { fieldViolationsOf, grpcCode, mentionsIdempotency, resourceNameOf, serverMessage, traceCodeOf } from "./status.js"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024

export interface ApiCall {
  operation: OperationSpec
  pathParams?: Record<string, string>
  query?: Record<string, string | undefined>
  body?: Record<string, unknown>
  idempotencyKey?: string
}

export class RequestSender {
  constructor(private readonly config: ResolvedConfig) {}

  async call<T>(input: ApiCall): Promise<T> {
    const idempotencyKey = input.operation.idempotent ? this.keyFor(input) : undefined
    const body = input.operation.http === "GET" ? undefined : { ...(input.body ?? {}) }
    if (body && idempotencyKey) body.idempotencyKey = idempotencyKey
    let path: string
    try {
      path = fillPath(input.operation.path, input.pathParams ?? {})
    } catch (error) {
      throw new SigningflowInvalidRequestError(error instanceof Error ? error.message : "invalid path", { idempotencyKey })
    }
    let url: URL
    try {
      url = resolveUrl(this.config.baseUrl, path, input.query)
    } catch (error) {
      throw new SigningflowInvalidRequestError(error instanceof Error ? error.message : "invalid path", { idempotencyKey })
    }
    if (queryContainsSecret(url.search, this.config.apiKey)) {
      throw new SigningflowInvalidRequestError("The API key must not be sent in the query string.", { idempotencyKey })
    }
    const retries = input.operation.http === "GET" || input.operation.idempotent ? this.config.maxNetworkRetries : 0
    let attempt = 0
    for (;;) {
      try {
        const response = await this.once(url, input.operation.http, body)
        if (response.status >= 200 && response.status < 300) return await parseSuccess<T>(response)
        if (attempt < retries && retryableStatus(response.status)) {
          attempt += 1
          await sleep(retryDelayMs(response.headers.get("rate-limit-retry-after"), response.headers.get("rate-limit-reset-after")))
          continue
        }
        throw await failure(response, input.operation.capability, idempotencyKey)
      } catch (error) {
        if (error instanceof SigningflowError) throw error
        if (attempt < retries) {
          attempt += 1
          continue
        }
        const aborted = error instanceof Error && error.name === "AbortError"
        throw new SigningflowConnectionError(aborted ? "The API timed out." : "The API could not be reached.", {
          statusCode: aborted ? 408 : 0,
          idempotencyKey,
        })
      }
    }
  }

  async putBytes(url: URL, bytes: Uint8Array, contentType: string): Promise<void> {
    const retries = this.config.maxNetworkRetries
    let attempt = 0
    for (;;) {
      try {
        const response = await this.send(url, "PUT", Buffer.from(bytes), {
          "Content-Type": contentType,
          "x-goog-if-generation-match": "0",
        })
        if ((response.status >= 200 && response.status < 300) || response.status === 412) return
        if (attempt < retries && response.status >= 500) {
          attempt += 1
          continue
        }
        throw new SigningflowAPIError("Uploading the file to storage failed.", { statusCode: response.status })
      } catch (error) {
        if (error instanceof SigningflowError) throw error
        if (attempt < retries) {
          attempt += 1
          continue
        }
        throw new SigningflowConnectionError("The upload could not be reached.", { statusCode: 0 })
      }
    }
  }

  private keyFor(input: ApiCall): string {
    const supplied = input.idempotencyKey?.trim() || text(input.body?.idempotencyKey)
    if (!supplied) return randomUUID()
    if (!UUID.test(supplied)) {
      throw new SigningflowInvalidRequestError("idempotencyKey must be a UUID.", {})
    }
    return supplied
  }

  private once(url: URL, method: OperationSpec["http"], body: Record<string, unknown> | undefined): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.apiKey}`,
      "X-Request-Workspace-Id": this.config.workspaceId,
      "X-Request-Env": this.config.env,
      "X-Request-Source": this.config.source,
      Accept: "application/json",
      "User-Agent": this.config.source,
    }
    if (this.config.channel) headers["X-Request-Channel"] = this.config.channel
    if (this.config.funnel) headers["X-Request-Funnel"] = this.config.funnel
    if (method !== "GET") headers["Content-Type"] = "application/json"
    return this.send(url, method, method === "GET" ? undefined : JSON.stringify(body ?? {}), headers)
  }

  private async send(url: URL, method: string, body: BodyInit | undefined, headers: Record<string, string>): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.config.timeout)
    try {
      return await this.config.fetch(url, { method, headers, body, signal: controller.signal, redirect: "manual" })
    } finally {
      clearTimeout(timer)
    }
  }
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

async function parseSuccess<T>(response: Response): Promise<T> {
  const type = response.headers.get("content-type") ?? ""
  const textBody = await readLimited(response)
  if (!textBody) return {} as T
  if (type && !type.includes("json") && !type.includes("text/")) {
    throw new SigningflowAPIError("The API returned a non-JSON body.", { statusCode: response.status })
  }
  try {
    return JSON.parse(textBody) as T
  } catch {
    throw new SigningflowAPIError("The API returned invalid JSON.", { statusCode: response.status })
  }
}

async function failure(response: Response, capability: string, idempotencyKey?: string): Promise<SigningflowError> {
  const textBody = await readLimited(response)
  let parsed: unknown = textBody
  if (textBody) {
    try {
      parsed = JSON.parse(textBody)
    } catch {
      parsed = textBody
    }
  }
  const message = redactMessage(serverMessage(parsed) || textBody || `Request failed with status ${response.status}.`)
  const fields: ErrorFields = {
    statusCode: response.status,
    grpcCode: grpcCode(parsed),
    traceCode: traceCodeOf(parsed),
    requestId: response.headers.get("x-request-id") ?? undefined,
    idempotencyKey,
    capability,
    fieldViolations: redactViolations(fieldViolationsOf(parsed)),
    retryAfter: response.headers.get("rate-limit-retry-after") ?? response.headers.get("rate-limit-reset-after") ?? undefined,
  }
  if (response.status === 401) return new SigningflowAuthenticationError(message, fields)
  if (response.status === 403) return new SigningflowPermissionError(message, fields)
  if (response.status === 409 && mentionsIdempotency(parsed)) {
    return new SigningflowIdempotencyError(message, { ...fields, resourceName: resourceNameOf(parsed) })
  }
  if (response.status === 429) return new SigningflowRateLimitError(message, fields)
  if (response.status >= 400 && response.status < 500) return new SigningflowInvalidRequestError(message, fields)
  return new SigningflowAPIError(message, fields)
}

function text(value: unknown): string {
  return typeof value === "string" ? value : ""
}

async function readLimited(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new SigningflowAPIError("The API response is larger than 8 MB.", { statusCode: response.status })
  }
  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw new SigningflowAPIError("The API response is larger than 8 MB.", { statusCode: response.status })
      }
      chunks.push(value)
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // The reader is already released after cancel.
    }
  }
  return Buffer.concat(chunks).toString("utf8")
}
