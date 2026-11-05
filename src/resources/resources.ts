import { randomUUID } from "node:crypto"
import { basename, extname } from "node:path"
import { OPERATIONS } from "../allowlist.js"
import type { ResolvedConfig } from "../config.js"
import { attachEnvelope, SigningflowAPIError, SigningflowConnectionError, SigningflowIdempotencyError, SigningflowInvalidRequestError } from "../errors.js"
import {
  cleanRecipients,
  envelopeNameOf,
  envelopeState,
  sentMillis,
  requireEnvelopeName,
  requireTemplateName,
  text,
  unwrapEnvelope,
  type Envelope,
  type Recipient,
} from "../envelope.js"
import { listItems, nextToken, pageOf, type ApiList } from "../pagination.js"
import { readJailed } from "../jail.js"
import { allowedUploadUrl } from "../path.js"
import type { RequestSender } from "../RequestSender.js"

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
const SEND_RECOVERY_WINDOW_MS = 120_000
const SEND_RECOVERY_SKEW_MS = 60_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".txt": "text/plain",
  ".json": "application/json",
}

export interface StoredFile {
  name: string
  id: string
}

export interface FileCreateParams {
  file: Buffer | Uint8Array | string
  filename?: string
  mimeType?: string
  idempotencyKey?: string
}

export class Files {
  constructor(
    private readonly sender: RequestSender,
    private readonly config: ResolvedConfig,
  ) {}

  async create(params: FileCreateParams): Promise<StoredFile> {
    const loaded = await loadFile(params, this.config.uploadRoot)
    const added = await this.sender.call<unknown>({
      operation: OPERATIONS.StorageService_BatchAddStorage,
      idempotencyKey: params.idempotencyKey,
      body: {
        storages: [{
          originalName: loaded.filename,
          displayName: loaded.filename,
          size: String(loaded.bytes.byteLength),
          extension: loaded.extension,
          mimeType: loaded.mimeType,
        }],
      },
    })
    const storage = findStorage(added)
    if (!storage) throw new SigningflowAPIError("Storage did not return an upload URL.")
    let uploadUrl: URL
    try {
      uploadUrl = allowedUploadUrl(storage.url, this.config.uploadHosts)
    } catch (error) {
      throw new SigningflowInvalidRequestError(error instanceof Error ? error.message : "upload url rejected")
    }
    await this.sender.putBytes(uploadUrl, loaded.bytes, loaded.mimeType)
    await this.sender.call({
      operation: OPERATIONS.StorageService_BatchAcknowledgeUpload,
      body: { names: [storage.name] },
    })
    return { name: storage.name, id: storage.id }
  }
}

export class Envelopes {
  constructor(
    private readonly sender: RequestSender,
    private readonly files: Files,
    private readonly templates: Templates,
  ) {}

  async create(params: { displayName: string; description?: string; storageId: string; idempotencyKey?: string }): Promise<Envelope> {
    const title = params.displayName.trim()
    if (!title) throw new SigningflowInvalidRequestError("Name the draft title.")
    if (!params.storageId.trim()) throw new SigningflowInvalidRequestError("storageId is required.")
    const created = await this.sender.call<unknown>({
      operation: OPERATIONS.EnvelopeService_AddEnvelope,
      idempotencyKey: params.idempotencyKey,
      body: {
        envelope: {
          display_name: title,
          description: params.description?.trim() ?? "",
          documents: [{
            display_name: title,
            attachments: [{ storage_id: params.storageId.trim() }],
            supplemental: false,
          }],
        },
      },
    })
    return createdEnvelope(created)
  }

  async retrieve(name: string, params?: { readMask?: string }): Promise<Envelope> {
    const envelope = requireEnvelopeName(name)
    const viewed = await this.sender.call<unknown>({
      operation: OPERATIONS.EnvelopeService_ViewEnvelope,
      pathParams: { name: envelope },
      query: { readMask: params?.readMask },
    })
    const unwrapped = unwrapEnvelope(viewed)
    if (!unwrapped.name) unwrapped.name = envelope
    return unwrapped
  }

  async update(name: string, body: Record<string, unknown>): Promise<Envelope> {
    const envelope = requireEnvelopeName(name)
    const updated = await this.sender.call<unknown>({
      operation: OPERATIONS.EnvelopeService_UpdateEnvelope,
      pathParams: { name: envelope },
      body: { ...body, name: text(body.name) || envelope },
    })
    return unwrapEnvelope(updated)
  }

  async send(name: string, params?: { idempotencyKey?: string }): Promise<Envelope> {
    const envelope = requireEnvelopeName(name)
    const sent = await this.sender.call<unknown>({
      operation: OPERATIONS.EnvelopeService_SendEnvelope,
      pathParams: { name: envelope },
      idempotencyKey: params?.idempotencyKey,
      body: {},
    })
    const unwrapped = unwrapEnvelope(sent)
    if (!unwrapped.name) unwrapped.name = envelope
    return unwrapped
  }

  async list(params: { directory: string; pageSize?: number; pageToken?: string; readMask?: string }): Promise<ApiList<Envelope>> {
    const directory = params.directory.trim()
    if (!directory) throw new SigningflowInvalidRequestError("directory is required.")
    const pageSize = pageSizeOf(params.pageSize)
    const load = (pageToken?: string) => this.listPage({ directory, pageSize, pageToken, readMask: params.readMask })
    return pageOf(await load(params.pageToken), (pageToken) => load(pageToken))
  }

  async remind(name: string): Promise<Envelope> {
    const envelope = requireEnvelopeName(name)
    const reminded = await this.sender.call<unknown>({
      operation: OPERATIONS.EnvelopeService_RemindEnvelopeSigners,
      pathParams: { name: envelope },
      body: {},
    })
    const unwrapped = unwrapEnvelope(reminded)
    if (!unwrapped.name) unwrapped.name = envelope
    return unwrapped
  }

  async download(name: string): Promise<EnvelopeDownload> {
    const envelope = requireEnvelopeName(name)
    const downloaded = await this.sender.call<Record<string, unknown>>({
      operation: OPERATIONS.EnvelopeService_DownloadEnvelope,
      pathParams: { name: envelope },
    })
    return {
      uri: text(downloaded.uri),
      download_time: text(downloaded.download_time) || text(downloaded.downloadTime),
      etag: text(downloaded.etag),
    }
  }

  async prepareDraft(params: { title: string; file: Buffer | Uint8Array | string; message?: string; filename?: string }): Promise<Envelope> {
    const title = params.title.trim()
    if (!title) throw new SigningflowInvalidRequestError("Name the PDF and the draft title.")
    const stored = await this.files.create({ file: params.file, filename: params.filename })
    return this.create({ displayName: title, description: params.message, storageId: stored.id })
  }

  async sendDocument(params: { title: string; file: Buffer | Uint8Array | string; recipients: Recipient[]; message?: string; filename?: string }): Promise<Envelope> {
    const title = params.title.trim()
    if (!title) throw new SigningflowInvalidRequestError("Name the PDF, the title, and the recipients.")
    const people = cleanRecipients(params.recipients)
    const stored = await this.files.create({ file: params.file, filename: params.filename })
    const created = await this.create({ displayName: title, description: params.message, storageId: stored.id })
    return this.finishSend(created, people, params.message, title)
  }

  async sendFromTemplate(params: { template: string; recipients: Recipient[]; message?: string }): Promise<Envelope> {
    const template = requireTemplateName(params.template)
    const people = cleanRecipients(params.recipients)
    const created = await this.templates.use(template)
    return this.finishSend(created, people, params.message, template)
  }

  async downloadCompleted(name: string): Promise<EnvelopeDownload> {
    const envelope = requireEnvelopeName(name)
    const viewed = await this.retrieve(envelope)
    if (envelopeState(viewed).trim().toUpperCase() !== "COMPLETED") {
      throw new SigningflowInvalidRequestError("The signed file is not ready.", { envelopeName: envelope })
    }
    return this.download(envelope)
  }

  private async finishSend(created: Envelope, people: Recipient[], message: string | undefined, label: string): Promise<Envelope> {
    const name = created.name ?? ""
    if (!requireEnvelopeNameSafe(name)) {
      throw new SigningflowAPIError(`${label} was saved without an envelope name.`)
    }
    try {
      const viewed = await this.retrieve(name, { readMask: "documents,compliance" })
      const patched = withRecipients(viewed, people, message)
      if (!patched) {
        throw new SigningflowInvalidRequestError("The draft has no document to address.", { envelopeName: name })
      }
      await this.update(name, patched)
      return await this.sendOrView(name)
    } catch (error) {
      attachEnvelope(error, name)
    }
  }

  private async sendOrView(name: string): Promise<Envelope> {
    const started = Date.now()
    try {
      return await this.send(name)
    } catch (error) {
      if (error instanceof SigningflowIdempotencyError && error.resourceName === name) {
        try {
          return await this.retrieve(name)
        } catch {
          attachEnvelope(error, name)
        }
      }
      if (error instanceof SigningflowConnectionError) {
        try {
          const viewed = await this.retrieve(name)
          const sent = sentMillis(viewed)
          if (sent !== undefined && sentDuringThisCall(sent, started, Date.now())) return viewed
        } catch {
          attachEnvelope(error, name)
        }
      }
      attachEnvelope(error, name)
    }
  }

  private async listPage(params: { directory: string; pageSize: number; pageToken?: string; readMask?: string }) {
    const body = await this.sender.call<Record<string, unknown>>({
      operation: OPERATIONS.EnvelopeService_ListEnvelopes,
      pathParams: { parent: "envelopes" },
      query: {
        directory: params.directory,
        pageSize: String(params.pageSize),
        pageToken: params.pageToken,
        readMask: params.readMask,
      },
    })
    return { data: listItems<Envelope>(body, "envelopes"), next_page_token: nextToken(body) }
  }
}

export interface EnvelopeDownload {
  uri?: string
  download_time?: string
  etag?: string
}

export class Templates {
  constructor(private readonly sender: RequestSender) {}

  async use(name: string, params?: { idempotencyKey?: string }): Promise<Envelope> {
    const template = requireTemplateName(name)
    const used = await this.sender.call<unknown>({
      operation: OPERATIONS.TemplateService_UseTemplate,
      pathParams: { name: template },
      idempotencyKey: params?.idempotencyKey,
      body: {},
    })
    return createdEnvelope(used)
  }
}

function createdEnvelope(body: unknown): Envelope {
  const unwrapped = unwrapEnvelope(body)
  const name = envelopeNameOf(body) || text(unwrapped.name)
  if (name) unwrapped.name = name
  return unwrapped
}

function requireEnvelopeNameSafe(name: string): boolean {
  try {
    requireEnvelopeName(name)
    return true
  } catch {
    return false
  }
}

function withRecipients(envelope: Envelope, people: Recipient[], message?: string): Record<string, unknown> | undefined {
  const documents = Array.isArray(envelope.documents) ? envelope.documents : []
  const refs = documents.flatMap((item) => {
    const uid = text(item.uid) || text(item.id)
    if (!uid) return []
    return [{ uid, display_name: text(item.display_name) || text(item.displayName) }]
  })
  if (refs.length === 0) return undefined
  const participants = people.map((person, index) => ({
    uid: randomUUID(),
    display_name: person.name,
    alternate_email: person.email,
    role: "SIGNER",
    type: "PERSONAL",
    action_order_type: "SERIAL",
    action_order_number: index + 1,
  }))
  const compliance = envelope.compliance
  const profile = compliance && text(compliance.profile) ? text(compliance.profile) : "STANDARD"
  return {
    name: text(envelope.name),
    display_name: text(envelope.display_name) || text(envelope.displayName),
    description: message?.trim() || text(envelope.description),
    compliance: { profile },
    documents: refs.map((document, index) => ({
      uid: document.uid,
      display_name: document.display_name,
      ...(index === 0 ? { participants } : {}),
    })),
  }
}

function sentDuringThisCall(sent: number, started: number, now: number): boolean {
  return sent >= started && sent <= started + SEND_RECOVERY_WINDOW_MS && sent <= now + SEND_RECOVERY_SKEW_MS
}

function pageSizeOf(value: number | undefined): number {
  const size = value ?? 10
  if (!Number.isInteger(size) || size < 1 || size > 1000) {
    throw new SigningflowInvalidRequestError("pageSize must be a whole number from 1 to 1000.")
  }
  return size
}

async function loadFile(params: FileCreateParams, uploadRoot: string | undefined): Promise<{ bytes: Uint8Array; filename: string; extension: string; mimeType: string }> {
  const bytes = await readBytes(params.file, uploadRoot)
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    throw new SigningflowInvalidRequestError("The file is larger than 25 MB.")
  }
  const filename = params.filename?.trim() || (typeof params.file === "string" ? basename(params.file) : "")
  if (!filename) throw new SigningflowInvalidRequestError("filename is required when file is not a path.")
  const extension = extname(filename).replace(/^\./, "").toLowerCase()
  const mimeType = params.mimeType?.trim() || MIME[`.${extension}`] || "application/octet-stream"
  return { bytes, filename, extension, mimeType }
}

async function readBytes(file: Buffer | Uint8Array | string, uploadRoot: string | undefined): Promise<Uint8Array> {
  if (typeof file !== "string") return Uint8Array.from(file)
  if (!uploadRoot) throw new SigningflowInvalidRequestError("A filesystem path requires uploadRoot.")
  try {
    return await readJailed(uploadRoot, file, MAX_UPLOAD_BYTES)
  } catch (error) {
    const message = error instanceof Error ? error.message : ""
    if (message === "too large") throw new SigningflowInvalidRequestError("The file is larger than 25 MB.")
    if (message === "outside root") throw new SigningflowInvalidRequestError("The path is outside uploadRoot.")
    if (message === "hard link") throw new SigningflowInvalidRequestError("The file must not be a hard link.")
    throw new SigningflowInvalidRequestError("The file could not be read.")
  }
}

function findStorage(body: unknown): { name: string; id: string; url: string } | undefined {
  const found: { name: string; id: string; url: string }[] = []
  walk(body, found)
  return found[0]
}

function walk(value: unknown, found: { name: string; id: string; url: string }[]) {
  if (!value || typeof value !== "object") return
  if (Array.isArray(value)) {
    for (const item of value) walk(item, found)
    return
  }
  const record = value as Record<string, unknown>
  const url = text(record.pre_signed_url) || text(record.preSignedUrl)
  const name = text(record.name)
  const id = name.split("/").pop() ?? ""
  if (name.startsWith("storages/") && UUID.test(id) && url) {
    found.push({ name, id, url })
  }
  for (const child of Object.values(record)) walk(child, found)
}
