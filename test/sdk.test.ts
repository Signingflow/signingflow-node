import assert from "node:assert/strict"
import { createHash, createHmac } from "node:crypto"
import { linkSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici"
import {
  Signingflow,
  SigningflowAPIError,
  SigningflowAuthenticationError,
  SigningflowConnectionError,
  SigningflowError,
  SigningflowIdempotencyError,
  SigningflowInvalidRequestError,
  SigningflowPermissionError,
  SigningflowRateLimitError,
  signingSecretOf,
} from "../src/index.js"
import { readJailed } from "../src/jail.js"
import { retryDelayMs } from "../src/net/retry.js"
import { allowedUploadUrl, fillPath, resolveUrl } from "../src/path.js"

const ID = "00000000-0000-4000-8000-000000000001"
const DOC = "00000000-0000-4000-8000-000000000002"
const STORAGE = "00000000-0000-4000-8000-000000000004"
const TEMPLATE = "00000000-0000-4000-8000-000000000005"
const HOOK = "00000000-0000-4000-8000-000000000006"
const DELIVERY = "00000000-0000-4000-8000-000000000007"
const KEY = "00000000-0000-4000-8000-000000000008"
const ENVELOPE = `envelopes/${ID}`
const API_KEY = "df_sk_test_secret"

interface Hit {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
  bytes?: number
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })
}

function scripted(handler: (hit: Hit, index: number) => Response | Promise<Response>, options: { uploadRoot?: string } = {}) {
  const hits: Hit[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value
    })
    const raw = init?.body
    const hit: Hit = {
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof raw === "string" ? raw : undefined,
      bytes: raw instanceof Uint8Array ? raw.byteLength : undefined,
    }
    hits.push(hit)
    return handler(hit, hits.length - 1)
  }
  const client = new Signingflow(API_KEY, {
    workspaceId: "ws-1",
    env: "sandbox",
    maxNetworkRetries: 0,
    uploadRoot: options.uploadRoot,
    fetch: fetchImpl,
  })
  return { client, hits, fetchImpl }
}

function uploadOk(url: string): Response | undefined {
  if (url.startsWith("https://storage.googleapis.com") || url.startsWith("https://files.example.com")) {
    return new Response(null, { status: 200 })
  }
  return undefined
}

test("constructor rejects missing configuration", () => {
  assert.throws(() => new Signingflow("  ", { workspaceId: "ws", env: "sandbox" }), SigningflowError)
  assert.throws(() => new Signingflow(API_KEY, { workspaceId: " ", env: "sandbox" }), /workspaceId/)
  assert.throws(() => new Signingflow(API_KEY, { workspaceId: "ws", env: "qa" as "sandbox" }), /env/)
  assert.throws(() => new Signingflow(API_KEY, { workspaceId: "ws", env: "sandbox", baseUrl: "not a url" }), /absolute/)
  assert.throws(() => new Signingflow(API_KEY, { workspaceId: "ws", env: "sandbox", baseUrl: "ftp://files.example.com" }), /https/)
  assert.throws(() => new Signingflow(API_KEY, { workspaceId: "ws", env: "sandbox", baseUrl: "http://api.signingflow.com" }), /https/)
  assert.throws(() => new Signingflow(API_KEY, { workspaceId: "ws", env: "sandbox", baseUrl: "https://user:pass@api.signingflow.com" }), /username/)
  assert.throws(() => new Signingflow(API_KEY, { workspaceId: "ws", env: "sandbox", baseUrl: "https://files.example.com" }), /allowCustomBaseUrl/)
  assert.doesNotThrow(() => new Signingflow(API_KEY, { workspaceId: "ws", env: "sandbox", baseUrl: "https://files.example.com", allowCustomBaseUrl: true }))
  assert.throws(() => new Signingflow(API_KEY, { workspaceId: "ws", env: "sandbox", uploadHosts: ["com"] }), /public suffix/)
  assert.throws(() => new Signingflow(API_KEY, { workspaceId: "ws", env: "sandbox", uploadHosts: ["example.com"] }), /public suffix/)
  assert.throws(() => new Signingflow(API_KEY, { workspaceId: "ws", env: "live", timeout: 0 }), /timeout/)
  assert.throws(() => new Signingflow(API_KEY, { workspaceId: "ws", env: "LIVE", maxNetworkRetries: 1.5 }), /maxNetworkRetries/)
})

test("requests send auth headers and camelCase query names", async () => {
  const { client, hits } = scripted((hit) => {
    assert.equal(hit.headers.authorization, `Bearer ${API_KEY}`)
    assert.equal(hit.headers["x-request-workspace-id"], "ws-1")
    assert.equal(hit.headers["x-request-env"], "SANDBOX")
    assert.equal(hit.headers["x-request-source"], "signingflow-node/0.1.0")
    assert.equal(hit.headers["x-api-key"], undefined)
    assert.equal(hit.url.includes(API_KEY), false)
    if (hit.url.includes(":view")) return json(200, { name: ENVELOPE, display_name: "NDA" })
    return json(200, { envelopes: [{ name: ENVELOPE }], next_page_token: "MTA=" })
  })
  const page = await client.envelopes.list({ directory: "needAction", pageSize: 10, readMask: "documents" })
  assert.equal(page.data[0]?.name, ENVELOPE)
  assert.equal(page.next_page_token, "MTA=")
  const list = new URL(hits[0].url)
  assert.equal(list.pathname, "/v1/envelopes")
  assert.equal(list.searchParams.get("directory"), "needAction")
  assert.equal(list.searchParams.get("pageSize"), "10")
  assert.equal(list.searchParams.get("readMask"), "documents")
  assert.equal(list.searchParams.get("read_mask"), null)
  await client.envelopes.retrieve(ENVELOPE, { readMask: "documents,compliance" })
  assert.equal(new URL(hits[1].url).searchParams.get("readMask"), "documents,compliance")
})

test("live env, channel, funnel, and trailing base URL", async () => {
  const hits: Hit[] = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value
    })
    hits.push({ url: String(input), method: init?.method ?? "GET", headers })
    return json(200, { name: ENVELOPE })
  }
  const client = new Signingflow(`  ${API_KEY}  `, {
    workspaceId: "  ws-1  ",
    env: "live",
    baseUrl: "https://api.signingflow.com/",
    channel: " email ",
    funnel: " ",
    fetch: fetchImpl,
    maxNetworkRetries: 0,
  })
  await client.envelopes.retrieve(ENVELOPE)
  assert.equal(hits[0].headers["x-request-env"], "LIVE")
  assert.equal(hits[0].headers["x-request-channel"], "email")
  assert.equal(hits[0].headers["x-request-funnel"], undefined)
  assert.equal(new URL(hits[0].url).origin, "https://api.signingflow.com")
})

test("maps status errors and redacts secrets", async () => {
  const cases: Array<[number, unknown, typeof SigningflowError, Record<string, string>?]> = [
    [401, { code: 16, message: `Unauthorized Bearer ${API_KEY}` }, SigningflowAuthenticationError],
    [403, { code: 7, message: "Permission denied.", details: [{ metadata: { trace_code: "43018" } }] }, SigningflowPermissionError, { "x-request-id": "req-1" }],
    [400, { code: 3, message: "Invalid Arguments.", details: [{ fieldViolations: [{ field: "directory", description: "required" }], metadata: { trace_code: "43588" } }] }, SigningflowInvalidRequestError],
    [409, { code: 6, message: "Already exists.", details: [{ reason: "idempotency", metadata: { resource_url: ENVELOPE, trace_code: "21103" } }] }, SigningflowIdempotencyError],
    [429, { message: "Slow down." }, SigningflowRateLimitError, { "rate-limit-retry-after": "2026-11-05T00:00:00Z", "rate-limit-remaining": "0" }],
    [500, "boom", SigningflowAPIError],
    [200, "not-json", SigningflowAPIError, { "content-type": "application/json" }],
    [200, "pdf", SigningflowAPIError, { "content-type": "application/pdf" }],
  ]
  for (const [status, body, type, headers] of cases) {
    const { client } = scripted(() => {
      if (typeof body === "string" && headers?.["content-type"] === "application/pdf") {
        return new Response(body, { status, headers })
      }
      if (typeof body === "string" && status === 200) return new Response(body, { status, headers: { "content-type": "application/json" } })
      if (typeof body === "string") return new Response(body, { status, headers })
      return json(status, body, headers)
    })
    await assert.rejects(client.envelopes.retrieve(ENVELOPE), (error: unknown) => {
      assert.ok(error instanceof type)
      assert.equal(String((error as Error).message).includes(API_KEY), false)
      return true
    })
  }
  const { client } = scripted(() => json(403, { message: "no" }))
  await assert.rejects(client.envelopes.retrieve(ENVELOPE), (error: unknown) => {
    assert.ok(error instanceof SigningflowPermissionError)
    assert.equal(error.capability, "envelope:read")
    return true
  })
  const idem = scripted(() => json(409, { code: 6, message: "Already exists.", details: [{ reason: "error.already_exists.reason_idempotency_key_already_processed", metadata: { resource_url: ENVELOPE, trace_code: "21103" } }] }))
  await assert.rejects(idem.client.envelopes.send(ENVELOPE), (error: unknown) => {
    assert.ok(error instanceof SigningflowIdempotencyError)
    assert.equal(error.resourceName, ENVELOPE)
    assert.equal(error.traceCode, "21103")
    assert.equal(error.grpcCode, 6)
    return true
  })
  const other = scripted(() => json(409, { code: 6, message: "Already exists." }))
  await assert.rejects(other.client.envelopes.remind(ENVELOPE), (error: unknown) => {
    assert.ok(error instanceof SigningflowInvalidRequestError)
    return true
  })
  const plain = scripted(() => json(409, { code: 9, message: "Conflict." }))
  await assert.rejects(plain.client.envelopes.remind(ENVELOPE), (error: unknown) => {
    assert.ok(error instanceof SigningflowInvalidRequestError)
    return true
  })
  const violations = scripted(() => json(400, { message: "Invalid Arguments.", details: [{ field_violations: [{ field: "page_size", description: "Bearer df_sk_live_secret required" }] }] }))
  await assert.rejects(violations.client.envelopes.list({ directory: "needAction" }), (error: unknown) => {
    assert.ok(error instanceof SigningflowInvalidRequestError)
    assert.equal(error.fieldViolations?.[0]?.field, "page_size")
    assert.equal(error.fieldViolations?.[0]?.description, "Bearer [redacted] required")
    return true
  })
})

test("retries idempotent writes and reads, not update or remind", async () => {
  let creates = 0
  const created = scripted((hit) => {
    creates += 1
    if (creates === 1) return json(500, { message: "try again" })
    const body = JSON.parse(hit.body ?? "{}") as { idempotencyKey: string }
    assert.equal(body.idempotencyKey, KEY)
    return json(201, { name: ENVELOPE, display_name: "NDA" })
  })
  created.client = new Signingflow(API_KEY, { workspaceId: "ws-1", env: "sandbox", maxNetworkRetries: 2, fetch: created.fetchImpl })
  const envelope = await created.client.envelopes.create({ displayName: "NDA", storageId: STORAGE, idempotencyKey: KEY })
  assert.equal(envelope.name, ENVELOPE)
  assert.equal(creates, 2)

  let updates = 0
  const updated = scripted(() => {
    updates += 1
    return json(500, { message: "no" })
  })
  updated.client = new Signingflow(API_KEY, { workspaceId: "ws-1", env: "sandbox", maxNetworkRetries: 2, fetch: updated.fetchImpl })
  await assert.rejects(updated.client.envelopes.update(ENVELOPE, { display_name: "NDA" }), SigningflowAPIError)
  assert.equal(updates, 1)

  let reminds = 0
  const reminded = scripted((hit) => {
    reminds += 1
    assert.equal(JSON.parse(hit.body ?? "{}").idempotencyKey, undefined)
    return json(200, { name: ENVELOPE, reminded_count: 2 })
  })
  const result = await reminded.client.envelopes.remind(ENVELOPE)
  assert.equal(result.name, ENVELOPE)
  assert.equal(reminds, 1)

  let reads = 0
  const read = scripted(() => {
    reads += 1
    if (reads === 1) return json(503, { message: "later" }, { "rate-limit-reset-after": "2000-01-01T00:00:00Z" })
    return json(200, { name: ENVELOPE })
  })
  read.client = new Signingflow(API_KEY, { workspaceId: "ws-1", env: "sandbox", maxNetworkRetries: 1, fetch: read.fetchImpl })
  assert.equal((await read.client.envelopes.retrieve(ENVELOPE)).name, ENVELOPE)

  const limited = scripted(() => json(429, { message: "Slow down." }, { "rate-limit-retry-after": new Date(Date.now() + 15).toISOString() }))
  limited.client = new Signingflow(API_KEY, { workspaceId: "ws-1", env: "sandbox", maxNetworkRetries: 1, fetch: limited.fetchImpl })
  await assert.rejects(limited.client.envelopes.retrieve(ENVELOPE), (error: unknown) => {
    assert.ok(error instanceof SigningflowRateLimitError)
    assert.ok(error.retryAfter)
    return true
  })
})

test("connection failures expose the idempotency key", async () => {
  const { fetchImpl } = scripted(() => json(200, {}))
  const failing: typeof fetch = async (_input, init) => {
    assert.ok(init?.signal)
    throw Object.assign(new Error("abort"), { name: "AbortError" })
  }
  const client = new Signingflow(API_KEY, { workspaceId: "ws-1", env: "sandbox", maxNetworkRetries: 0, fetch: failing })
  await assert.rejects(client.envelopes.send(ENVELOPE, { idempotencyKey: KEY }), (error: unknown) => {
    assert.ok(error instanceof SigningflowConnectionError)
    assert.equal(error.idempotencyKey, KEY)
    assert.equal(error.statusCode, 408)
    return true
  })
  const down = new Signingflow(API_KEY, {
    workspaceId: "ws-1",
    env: "sandbox",
    maxNetworkRetries: 1,
    fetch: async () => {
      throw new Error("offline")
    },
  })
  await assert.rejects(down.envelopes.retrieve(ENVELOPE), (error: unknown) => {
    assert.ok(error instanceof SigningflowConnectionError)
    assert.match(error.message, /could not be reached/)
    return true
  })
  assert.equal(typeof fetchImpl, "function")
})

test("rejects a non-uuid idempotency key and a key in the query", async () => {
  const { client } = scripted(() => json(200, {}))
  await assert.rejects(client.envelopes.create({ displayName: "NDA", storageId: STORAGE, idempotencyKey: "same-key" }), /UUID/)
  await assert.rejects(client.envelopes.retrieve(ENVELOPE, { readMask: API_KEY }), /query string/)
  await assert.rejects(client.envelopes.retrieve("envelopes/not-an-id"), /envelopes/)
  await assert.rejects(client.envelopes.list({ directory: " " }), /directory/)
  await assert.rejects(client.envelopes.list({ directory: "needAction", pageSize: 0 }), /pageSize/)
  await assert.rejects(client.envelopes.create({ displayName: " ", storageId: STORAGE }), /title/)
})

test("stores a file with PUT then acknowledge", async () => {
  const dir = mkdtempSync(join(tmpdir(), "signingflow-"))
  const file = join(dir, "contract.pdf")
  writeFileSync(file, Buffer.from("%PDF"))
  const signed = `https://storage.googleapis.com/bucket/file?X-Goog-Signature=${API_KEY}`
  const { client, hits } = scripted((hit) => {
    const uploaded = uploadOk(hit.url)
    if (uploaded) return uploaded
    if (hit.url.includes("batchAddStorage")) {
      return json(200, { storages: [{ name: `storages/${STORAGE}`, pre_signed_url: signed }] })
    }
    assert.match(hit.url, /batchAcknowledgeUpload/)
    const body = JSON.parse(hit.body ?? "{}") as { names: string[]; idempotencyKey: string }
    assert.deepEqual(body.names, [`storages/${STORAGE}`])
    assert.match(body.idempotencyKey, /^[0-9a-f-]{36}$/i)
    return json(200, {})
  }, { uploadRoot: dir })
  const stored = await client.files.create({ file })
  assert.equal(stored.id, STORAGE)
  const put = hits.find((hit) => hit.method === "PUT")
  assert.ok(put)
  assert.equal(put.headers.authorization, undefined)
  assert.equal(put.headers["content-type"], "application/pdf")
  assert.equal(put.headers["x-goog-if-generation-match"], "0")
  assert.equal(put.bytes, 4)
  const add = JSON.parse(hits[0].body ?? "{}") as { storages: Array<{ originalName: string; size: string }> }
  assert.equal(add.storages[0].originalName, "contract.pdf")
  assert.equal(add.storages[0].size, "4")
})

test("upload failures stop before acknowledge", async () => {
  const bytes = new Uint8Array([1, 2, 3])
  const evil = scripted((hit) => {
    if (hit.url.includes("batchAddStorage")) return json(200, { storages: [{ name: `storages/${STORAGE}`, preSignedUrl: "https://evil.example/file" }] })
    return json(200, {})
  })
  await assert.rejects(evil.client.files.create({ file: bytes, filename: "a.pdf" }), /upload host/)
  assert.equal(evil.hits.some((hit) => hit.url.includes("batchAcknowledge")), false)

  const httpUrl = scripted((hit) => {
    if (hit.url.includes("batchAddStorage")) return json(200, { storages: [{ name: `storages/${STORAGE}`, pre_signed_url: "http://storage.googleapis.com/file" }] })
    return json(200, {})
  })
  await assert.rejects(httpUrl.client.files.create({ file: bytes, filename: "a.pdf" }), /https/)

  const putFailed = scripted((hit) => {
    if (hit.method === "PUT") return new Response(null, { status: 500 })
    if (hit.url.includes("batchAddStorage")) return json(200, { storages: [{ name: `storages/${STORAGE}`, pre_signed_url: "https://storage.googleapis.com/file" }] })
    return json(200, {})
  })
  await assert.rejects(putFailed.client.files.create({ file: bytes, filename: "a.bin" }), /Uploading/)
  assert.equal(putFailed.hits.some((hit) => hit.url.includes("Acknowledge")), false)

  const early = scripted((hit) => {
    if (hit.method === "PUT") return { status: 100 } as Response
    if (hit.url.includes("batchAddStorage")) return json(200, { storages: [{ name: `storages/${STORAGE}`, pre_signed_url: "https://storage.googleapis.com/file" }] })
    return json(200, {})
  })
  await assert.rejects(early.client.files.create({ file: bytes, filename: "a.bin" }), /Uploading/)
  assert.equal(early.hits.some((hit) => hit.url.includes("Acknowledge")), false)

  const redirected = scripted((hit) => {
    if (hit.method === "PUT") return new Response(null, { status: 302, headers: { location: "https://evil.example/file" } })
    if (hit.url.includes("batchAddStorage")) return json(200, { storages: [{ name: `storages/${STORAGE}`, pre_signed_url: "https://storage.googleapis.com/file" }] })
    return json(200, {})
  })
  await assert.rejects(redirected.client.files.create({ file: bytes, filename: "a.bin" }), /Uploading/)

  const missing = scripted(() => json(200, { storages: [{ name: `storages/${STORAGE}`, pre_signed_url: "" }] }))
  await assert.rejects(missing.client.files.create({ file: bytes, filename: "a.pdf" }), /upload URL/)
  const root = mkdtempSync(join(tmpdir(), "signingflow-root-"))
  await assert.rejects(scripted(() => json(200, {})).client.files.create({ file: "/no/such/file.pdf" }), /uploadRoot/)
  await assert.rejects(scripted(() => json(200, {}), { uploadRoot: root }).client.files.create({ file: "/etc/passwd" }), /outside uploadRoot/)
  await assert.rejects(scripted(() => json(200, {}), { uploadRoot: root }).client.files.create({ file: join(root, "missing.pdf") }), /could not be read/)
  await assert.rejects(scripted(() => json(200, {})).client.files.create({ file: bytes }), /filename/)
  await assert.rejects(scripted(() => json(200, {})).client.files.create({ file: new Uint8Array(25 * 1024 * 1024 + 1), filename: "big.pdf" }), /25 MB/)
})

test("PUT 412 still acknowledges and a custom host is allowed", async () => {
  const bytes = new Uint8Array([9])
  let puts = 0
  const precondition = scripted((hit) => {
    if (hit.method === "PUT") {
      puts += 1
      return new Response(null, { status: 412 })
    }
    if (hit.url.includes("batchAddStorage")) return json(200, { storages: [{ name: `storages/${STORAGE}`, pre_signed_url: "https://storage.googleapis.com/file" }] })
    return json(200, { name: `storages/${STORAGE}` })
  })
  assert.equal((await precondition.client.files.create({ file: bytes, filename: "a.pdf", mimeType: "application/pdf" })).name, `storages/${STORAGE}`)
  assert.equal(puts, 1)

  const custom = new Signingflow(API_KEY, {
    workspaceId: "ws-1",
    env: "sandbox",
    uploadHosts: ["files.example.com"],
    maxNetworkRetries: 0,
    fetch: async (input, init) => {
      const url = String(input)
      if (init?.method === "PUT") return new Response(null, { status: 200 })
      assert.equal(init?.method, "POST")
      if (url.includes("batchAddStorage")) return json(200, { storages: [{ name: `storages/${STORAGE}`, pre_signed_url: "https://bucket.files.example.com/file" }] })
      return json(200, {})
    },
  })
  assert.equal((await custom.files.create({ file: bytes, filename: "note.txt" })).id, STORAGE)
})

test("sendDocument follows the skill order and keeps the draft name", async () => {
  const bytes = new Uint8Array([1])
  const { client, hits } = scripted((hit) => {
    const uploaded = uploadOk(hit.url)
    if (uploaded) return uploaded
    if (hit.url.includes("batchAddStorage")) return json(200, { storages: [{ name: `storages/${STORAGE}`, pre_signed_url: "https://storage.googleapis.com/file" }] })
    if (hit.url.includes("batchAcknowledge")) return json(200, {})
    if (hit.url.includes("addEnvelope")) return json(201, { envelope: { name: ENVELOPE, display_name: "NDA" } })
    if (hit.url.includes(":view")) {
      return json(200, { name: ENVELOPE, display_name: "NDA", documents: [{ uid: DOC, display_name: "NDA" }], compliance: { profile: "STANDARD" } })
    }
    if (hit.method === "PATCH") {
      const body = JSON.parse(hit.body ?? "{}") as { documents: Array<{ participants?: Array<{ alternate_email: string; action_order_number: number }> }> }
      assert.equal(body.documents[0].participants?.[0].alternate_email, "ada@example.com")
      assert.equal(body.documents[0].participants?.[0].action_order_number, 1)
      return json(200, { name: ENVELOPE })
    }
    if (hit.url.includes(":send")) return json(200, { name: ENVELOPE, progress_status: "SENT" })
    return json(500, { message: "unexpected" })
  })
  const sent = await client.envelopes.sendDocument({
    title: "NDA",
    file: bytes,
    filename: "nda.pdf",
    recipients: [{ name: "Ada Lovelace", email: "ada@example.com" }],
    message: "Please sign",
  })
  assert.equal(sent.progress_status, "SENT")
  assert.deepEqual(hits.map((hit) => hit.method), ["POST", "PUT", "POST", "POST", "GET", "PATCH", "POST"])

  const failed = scripted((hit) => {
    const uploaded = uploadOk(hit.url)
    if (uploaded) return uploaded
    if (hit.url.includes("batchAddStorage")) return json(200, { storages: [{ name: `storages/${STORAGE}`, pre_signed_url: "https://storage.googleapis.com/file" }] })
    if (hit.url.includes("batchAcknowledge")) return json(200, {})
    if (hit.url.includes("addEnvelope")) return json(201, { name: ENVELOPE })
    if (hit.url.includes(":view")) return json(200, { name: ENVELOPE, documents: [{ uid: DOC, display_name: "NDA" }] })
    if (hit.method === "PATCH") return json(400, { message: "bad recipients" })
    return json(500, { message: "send should not run" })
  })
  await assert.rejects(
    failed.client.envelopes.sendDocument({ title: "NDA", file: bytes, filename: "nda.pdf", recipients: [{ name: "Ada", email: "ada@example.com" }] }),
    (error: unknown) => {
      assert.ok(error instanceof SigningflowInvalidRequestError)
      assert.equal(error.envelopeName, ENVELOPE)
      return true
    },
  )
  assert.equal(failed.hits.some((hit) => hit.url.includes(":send")), false)
})

test("prepareDraft stops before send and download waits for COMPLETED", async () => {
  const bytes = new Uint8Array([1])
  const draft = scripted((hit) => {
    const uploaded = uploadOk(hit.url)
    if (uploaded) return uploaded
    if (hit.url.includes("batchAddStorage")) return json(200, { storages: [{ name: `storages/${STORAGE}`, pre_signed_url: "https://storage.googleapis.com/file" }] })
    if (hit.url.includes("batchAcknowledge")) return json(200, {})
    if (hit.url.includes("addEnvelope")) return json(201, { uid: ID, display_name: "NDA" })
    return json(500, { message: "no send" })
  })
  const created = await draft.client.envelopes.prepareDraft({ title: "NDA", file: bytes, filename: "nda.pdf" })
  assert.equal(created.name, ENVELOPE)
  assert.equal(draft.hits.some((hit) => hit.url.includes(":send")), false)

  const early = scripted(() => json(200, { name: ENVELOPE, progress_status: "SENT" }))
  await assert.rejects(early.client.envelopes.downloadCompleted(ENVELOPE), (error: unknown) => {
    assert.ok(error instanceof SigningflowInvalidRequestError)
    assert.equal(error.envelopeName, ENVELOPE)
    return true
  })
  assert.equal(early.hits.some((hit) => hit.url.includes(":download")), false)

  const ready = scripted((hit) => {
    if (hit.url.includes(":download")) return json(200, { uri: "https://storage.googleapis.com/signed", download_time: "2026-11-05T00:00:00Z", etag: "v1" })
    return json(200, { name: ENVELOPE, state: "COMPLETED" })
  })
  const file = await ready.client.envelopes.downloadCompleted(ENVELOPE)
  assert.equal(file.uri, "https://storage.googleapis.com/signed")
  assert.equal(file.etag, "v1")
})

test("sendFromTemplate and a timed-out send view the envelope before another send", async () => {
  const { client, hits } = scripted((hit) => {
    if (hit.url.includes(":use")) return json(200, { name: ENVELOPE })
    if (hit.url.includes(":view")) return json(200, { name: ENVELOPE, documents: [{ uid: DOC, display_name: "NDA" }], progress: { state: "DRAFT" } })
    if (hit.method === "PATCH") return json(200, { name: ENVELOPE })
    if (hit.url.includes(":send")) return json(200, { progress_status: "SENT" })
    return json(500, { message: "no" })
  })
  const sent = await client.envelopes.sendFromTemplate({
    template: `templates/${TEMPLATE}`,
    recipients: [{ name: "Ada", email: "ada@example.com" }],
  })
  assert.equal(sent.progress_status, "SENT")
  assert.equal(hits[0].url.includes(`templates/${TEMPLATE}:use`), true)

  let sends = 0
  const recovered = scripted((hit) => {
    if (hit.url.includes(":use")) return json(200, { envelope: { name: ENVELOPE } })
    if (hit.url.includes(":view") && sends === 0) return json(200, { name: ENVELOPE, documents: [{ uid: DOC }] })
    if (hit.method === "PATCH") return json(200, { name: ENVELOPE })
    if (hit.url.includes(":send")) {
      sends += 1
      throw new Error("timeout")
    }
    return json(200, { name: ENVELOPE, progress_status: "SENT", sentTime: new Date(Date.now() + 1000).toISOString() })
  })
  const viewed = await recovered.client.envelopes.sendFromTemplate({
    template: `templates/${TEMPLATE}`,
    recipients: [{ name: "Ada", email: "ada@example.com" }],
  })
  assert.equal(viewed.progress_status, "SENT")
  assert.equal(sends, 1)

  const stillDraft = scripted((hit) => {
    if (hit.url.includes(":use")) return json(200, { name: ENVELOPE })
    if (hit.url.includes("readMask")) return json(200, { name: ENVELOPE, documents: [{ uid: DOC, display_name: "NDA" }] })
    if (hit.method === "PATCH") return json(200, { name: ENVELOPE })
    if (hit.url.includes(":send")) throw new Error("timeout")
    return json(200, { name: ENVELOPE, state: "DRAFT" })
  })
  await assert.rejects(
    stillDraft.client.envelopes.sendFromTemplate({ template: `templates/${TEMPLATE}`, recipients: [{ name: "Ada", email: "ada@example.com" }] }),
    (error: unknown) => {
      assert.ok(error instanceof SigningflowConnectionError || error instanceof SigningflowInvalidRequestError)
      assert.equal((error as SigningflowError).envelopeName, ENVELOPE)
      return true
    },
  )
})

test("send recovery does not treat an older envelope as this call", async () => {
  const stale = scripted((hit) => {
    if (hit.url.includes(":use")) return json(200, { name: ENVELOPE })
    if (hit.url.includes("readMask")) return json(200, { name: ENVELOPE, documents: [{ uid: DOC }] })
    if (hit.method === "PATCH") return json(200, { name: ENVELOPE })
    if (hit.url.includes(":send")) throw new Error("timeout")
    return json(200, { name: ENVELOPE, progress_status: "SENT", sent_time: "2000-01-01T00:00:00.000Z" })
  })
  await assert.rejects(
    stale.client.envelopes.sendFromTemplate({ template: `templates/${TEMPLATE}`, recipients: [{ name: "Ada", email: "ada@example.com" }] }),
    (error: unknown) => {
      assert.ok(error instanceof SigningflowConnectionError)
      assert.equal(error.envelopeName, ENVELOPE)
      return true
    },
  )

  const replay = scripted((hit) => {
    if (hit.url.includes(":use")) return json(200, { name: ENVELOPE })
    if (hit.url.includes("readMask")) return json(200, { name: ENVELOPE, documents: [{ uid: DOC }] })
    if (hit.method === "PATCH") return json(200, { name: ENVELOPE })
    if (hit.url.includes(":send")) {
      return json(409, { code: 6, message: "Already exists.", details: [{ reason: "idempotency", metadata: { resource_url: ENVELOPE } }] })
    }
    return json(200, { name: ENVELOPE, sentTime: "2099-01-01T00:00:00.000Z" })
  })
  const viewed = await replay.client.envelopes.sendFromTemplate({
    template: `templates/${TEMPLATE}`,
    recipients: [{ name: "Ada", email: "ada@example.com" }],
  })
  assert.equal(viewed.name, ENVELOPE)

  const future = scripted((hit) => {
    if (hit.url.includes(":use")) return json(200, { name: ENVELOPE })
    if (hit.url.includes("readMask")) return json(200, { name: ENVELOPE, documents: [{ uid: DOC }] })
    if (hit.method === "PATCH") return json(200, { name: ENVELOPE })
    if (hit.url.includes(":send")) throw new Error("timeout")
    return json(200, { name: ENVELOPE, progress_status: "SENT", sent_time: "2099-01-01T00:00:00.000Z" })
  })
  await assert.rejects(
    future.client.envelopes.sendFromTemplate({ template: `templates/${TEMPLATE}`, recipients: [{ name: "Ada", email: "ada@example.com" }] }),
    (error: unknown) => {
      assert.ok(error instanceof SigningflowConnectionError)
      assert.equal(error.envelopeName, ENVELOPE)
      return true
    },
  )
})

test("a filesystem path stays inside uploadRoot", async () => {
  const root = mkdtempSync(join(tmpdir(), "signingflow-jail-"))
  const outside = mkdtempSync(join(tmpdir(), "signingflow-outside-"))
  writeFileSync(join(outside, "secret.pdf"), Buffer.from("%PDF"))
  symlinkSync(join(outside, "secret.pdf"), join(root, "link.pdf"))
  mkdirSync(join(root, "nested"))
  writeFileSync(join(root, "note.pdf"), Buffer.from("%PDF"))
  linkSync(join(outside, "secret.pdf"), join(root, "inside.pdf"))
  await assert.rejects(readJailed(root, "link.pdf", 100))
  await assert.rejects(readJailed(root, "inside.pdf", 100), /hard link/)
  await assert.rejects(scripted(() => json(200, {}), { uploadRoot: root }).client.files.create({ file: join(root, "inside.pdf") }), /hard link/)
  await assert.rejects(readJailed(root, "nested", 100), /not a file/)
  await assert.rejects(readJailed(root, "note.pdf", 1), /too large/)
  assert.equal((await readJailed(root, "note.pdf", 10)).byteLength, 4)
  await assert.rejects(readJailed(root, join("..", "secret.pdf"), 10), /outside root/)
})

test("rejects an API body larger than 8 MB", async () => {
  const oversized = () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1))
        controller.close()
      },
    })
    return new Response(stream, { status: 200, headers: { "content-type": "application/json" } })
  }
  await assert.rejects(scripted(() => oversized()).client.envelopes.retrieve(ENVELOPE), (error: unknown) => {
    assert.ok(error instanceof SigningflowAPIError)
    assert.match(error.message, /8 MB/)
    return true
  })
  await assert.rejects(scripted(() => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1))
        controller.close()
      },
    })
    return new Response(stream, { status: 500, headers: { "content-type": "application/json" } })
  }).client.envelopes.retrieve(ENVELOPE), /8 MB/)
})

test("lists page through next tokens", async () => {
  let pages = 0
  const { client } = scripted(() => {
    pages += 1
    if (pages === 1) return json(200, { envelopes: [{ name: ENVELOPE }, { name: `envelopes/${DOC}` }], nextPageToken: "MTA=" })
    return json(200, { envelopes: [{ name: `envelopes/${STORAGE}` }] })
  })
  const page = await client.envelopes.list({ directory: "waitingOthers" })
  const names: string[] = []
  await page.autoPagingEach((item) => {
    names.push(item.name ?? "")
  })
  assert.deepEqual(names, [ENVELOPE, `envelopes/${DOC}`, `envelopes/${STORAGE}`])
  const again = await client.webhookDeliveries.list({ pageSize: 2 })
  assert.equal(again.data.length >= 0, true)
})

test("webhook destination and deliveries", async () => {
  const { client, hits } = scripted((hit) => {
    if (hit.url.includes("webhookUrls:add")) {
      const body = JSON.parse(hit.body ?? "{}") as { webhookUrl: { displayName: string }; httpConfig?: unknown }
      assert.equal(body.webhookUrl.displayName, "Envelope events")
      assert.equal(body.httpConfig, undefined)
      return json(201, { name: `webhookUrls/${HOOK}`, signing_secret: "ab".repeat(32) })
    }
    if (hit.url.includes("/v1/webhooks/") && !hit.url.includes("webhookUrls")) {
      return json(200, { name: `webhooks/${DELIVERY}`, event: "DOC_ENVELOPE_COMPLETED" })
    }
    if (hit.method === "GET" && hit.url.includes(":view")) {
      return json(200, { name: `webhookUrls/${HOOK}`, signing_secret: "should-not-return", events: ["DOC_ENVELOPE_COMPLETED"] })
    }
    if (hit.url.includes(":test")) return json(200, { name: `webhookUrls/${HOOK}` })
    if (hit.url.endsWith("/v1/webhooks") || hit.url.includes("/v1/webhooks?")) {
      return json(200, { webhooks: [{ name: `webhooks/${DELIVERY}`, event: "DOC_ENVELOPE_COMPLETED" }] })
    }
    return json(200, { name: `webhooks/${DELIVERY}`, event: "DOC_ENVELOPE_COMPLETED" })
  })
  const created = await client.webhookUrls.create({
    displayName: "Envelope events",
    httpRequestUri: "https://example.com/hooks",
    events: ["DOC_ENVELOPE_COMPLETED"],
    idempotencyKey: KEY,
  })
  assert.equal(signingSecretOf(created), "ab".repeat(32))
  const viewed = await client.webhookUrls.retrieve(`webhookUrls/${HOOK}`)
  assert.equal(viewed.signing_secret, undefined)
  assert.equal(signingSecretOf(viewed), "")
  await client.webhookUrls.test(`webhookUrls/${HOOK}`)
  const deliveries = await client.webhookDeliveries.list()
  assert.equal(deliveries.data[0]?.event, "DOC_ENVELOPE_COMPLETED")
  assert.equal((await client.webhookDeliveries.retrieve(`webhooks/${DELIVERY}`)).name, `webhooks/${DELIVERY}`)
  assert.equal(new URL(hits.find((hit) => hit.url.includes("/v1/webhooks"))?.url ?? "").searchParams.get("pageSize"), "10")
  await assert.rejects(client.webhookUrls.create({ displayName: "", httpRequestUri: "https://example.com", events: ["DOC_ENVELOPE_COMPLETED"] }), /displayName/)
  await assert.rejects(client.webhookUrls.create({ displayName: "ok", httpRequestUri: "http://example.com", events: ["DOC_ENVELOPE_COMPLETED"] }), /https/)
  await assert.rejects(client.webhookUrls.create({ displayName: "ok", httpRequestUri: "https://example.com", events: [] }), /events/)
  await assert.rejects(client.webhookUrls.create({ displayName: "ok", httpRequestUri: "notaurl", events: ["DOC_ENVELOPE_COMPLETED"] }), /https/)
  await assert.rejects(client.webhookUrls.create({
    displayName: "ok",
    httpRequestUri: "https://example.com",
    events: ["DOC_ENVELOPE_COMPLETED"],
    httpConfig: { auth: "NONE" },
  }), /NONE/)
  await assert.rejects(client.webhookUrls.create({
    displayName: "ok",
    httpRequestUri: "https://example.com",
    events: ["DOC_ENVELOPE_COMPLETED"],
    httpConfig: { auth: "BEARER" },
  }), /HMAC/)
})

test("constructEvent checks the raw body and the previous secret", () => {
  const secret = "example-secret"
  const previous = "previous-secret"
  const payload = '{"id":"envelope-id","display_name":"NDA","progress_status":"COMPLETED"}'
  const signature = createHmac("sha256", secret).update(payload).digest("hex")
  const event = new Signingflow(API_KEY, { workspaceId: "ws-1", env: "sandbox" }).webhooks.constructEvent(payload, signature, secret)
  assert.equal((event.payload as { progress_status: string }).progress_status, "COMPLETED")
  assert.equal(event.bodySha256, createHash("sha256").update(payload).digest("hex"))
  assert.throws(() => new Signingflow(API_KEY, { workspaceId: "ws-1", env: "sandbox" }).webhooks.constructEvent(JSON.parse(payload), signature, secret), /raw request body/)
  const spaced = '{\n"id":"envelope-id"\n}'
  assert.throws(() => new Signingflow(API_KEY, { workspaceId: "ws-1", env: "sandbox" }).webhooks.constructEvent(spaced, signature, secret), /did not match/)
  const previousSignature = createHmac("sha256", previous).update(Buffer.from(payload)).digest("hex")
  const fromPrevious = new Signingflow(API_KEY, { workspaceId: "ws-1", env: "sandbox" }).webhooks.constructEvent(Buffer.from(payload), "00", secret, {
    previousSecret: previous,
    previousSignature,
  })
  assert.equal((fromPrevious.payload as { display_name: string }).display_name, "NDA")
  assert.equal(fromPrevious.bodySha256, createHash("sha256").update(payload).digest("hex"))
  assert.throws(() => new Signingflow(API_KEY, { workspaceId: "ws-1", env: "sandbox" }).webhooks.constructEvent(payload, signature, ""), /secret/)
  assert.throws(() => new Signingflow(API_KEY, { workspaceId: "ws-1", env: "sandbox" }).webhooks.constructEvent(new Uint8Array(Buffer.from("not-json")), createHmac("sha256", secret).update("not-json").digest("hex"), secret), /not JSON/)
})

test("path and retry helpers", () => {
  assert.equal(fillPath("/v1/{envelope.name}", { name: ENVELOPE }), `/v1/envelopes/${ID}`)
  assert.throws(() => fillPath("/v1/{name}", {}), /missing path param/)
  assert.throws(() => fillPath("/v1/{name}", { name: "envelopes/../x" }), /invalid path param/)
  assert.equal(resolveUrl("https://api.signingflow.com", "/v1/envelopes", { pageToken: "", pageSize: "10" }).search, "?pageSize=10")
  assert.throws(() => allowedUploadUrl("https://user:pass@storage.googleapis.com/file", ["storage.googleapis.com"]), /rejected/)
  assert.throws(() => allowedUploadUrl("notaurl", ["storage.googleapis.com"]), /rejected/)
  const later = Date.now() + 10_000
  assert.equal(retryDelayMs(new Date(later).toISOString(), null, later - 500), 500)
  assert.equal(retryDelayMs(null, new Date(Date.now() - 1000).toISOString()), 0)
  assert.equal(retryDelayMs("not-a-date", null), 0)
  assert.equal(retryDelayMs(new Date(Date.now() + 120_000).toISOString(), null), 60_000)
})

test("auto paging stops on a repeated token and a limit", async () => {
  const { client } = scripted(() => json(200, { webhooks: [{ name: `webhooks/${DELIVERY}` }], next_page_token: "same" }))
  const page = await client.webhookDeliveries.list({ pageSize: 1 })
  const rows = await page.autoPagingToArray({ limit: 1 })
  assert.equal(rows.length, 1)
  let seen = 0
  const looping = scripted(() => json(200, { envelopes: [{ name: ENVELOPE }], next_page_token: "same" }))
  const first = await looping.client.envelopes.list({ directory: "needAction" })
  await first.autoPagingEach(() => {
    seen += 1
  })
  assert.equal(seen, 2)
})

test("global fetch is used when no custom fetch is set", async () => {
  const agent = new MockAgent()
  agent.disableNetConnect()
  const previous = getGlobalDispatcher()
  setGlobalDispatcher(agent)
  try {
    const pool = agent.get("https://api.signingflow.com")
    pool.intercept({ path: `/v1/envelopes/${ID}:view`, method: "GET" }).reply(200, { name: ENVELOPE, display_name: "NDA" }, { headers: { "content-type": "application/json" } })
    const client = new Signingflow(API_KEY, { workspaceId: "ws-1", env: "sandbox", maxNetworkRetries: 0 })
    const envelope = await client.envelopes.retrieve(ENVELOPE)
    assert.equal(envelope.display_name, "NDA")
  } finally {
    await agent.close()
    setGlobalDispatcher(previous)
  }
})

test("empty success body and a template name check", async () => {
  const { client } = scripted((hit) => {
    if (hit.method === "POST") return new Response(null, { status: 200, headers: { "content-type": "application/json" } })
    return json(200, {})
  })
  await assert.rejects(client.envelopes.sendFromTemplate({
    template: `templates/${TEMPLATE}`,
    recipients: [{ name: "Ada", email: "ada@example.com" }],
  }), /envelope name/)
  await assert.rejects(client.templates.use("templates/nope"), /templates/)
  await assert.rejects(client.envelopes.sendDocument({
    title: "NDA",
    file: new Uint8Array([1]),
    filename: "a.pdf",
    recipients: [{ name: "", email: "ada@example.com" }],
  }), /email/)
})
