import { OPERATIONS } from "../allowlist.js"
import { SigningflowInvalidRequestError } from "../errors.js"
import { asRecord, text } from "../envelope.js"
import { listItems, nextToken, pageOf, type ApiList } from "../pagination.js"
import type { RequestSender } from "../RequestSender.js"

const WEBHOOK_URL = /^webhookUrls\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DELIVERY = /^webhooks\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface WebhookUrl {
  name?: string
  display_name?: string
  http_request_uri?: string
  events?: string[]
  signing_secret?: string
  [key: string]: unknown
}

export interface WebhookDelivery {
  name?: string
  event?: string
  [key: string]: unknown
}

export interface WebhookUrlCreateParams {
  displayName: string
  httpRequestUri: string
  events: string[]
  idempotencyKey?: string
  httpConfig?: { auth?: string }
}

export class WebhookUrls {
  constructor(private readonly sender: RequestSender) {}

  async create(params: WebhookUrlCreateParams): Promise<WebhookUrl> {
    const displayName = params.displayName.trim()
    if (displayName.length < 1 || displayName.length > 100) {
      throw new SigningflowInvalidRequestError("displayName must be 1 to 100 characters.")
    }
    let url: URL
    try {
      url = new URL(params.httpRequestUri)
    } catch {
      throw new SigningflowInvalidRequestError("httpRequestUri must be an https URL.")
    }
    if (url.protocol !== "https:") throw new SigningflowInvalidRequestError("httpRequestUri must be an https URL.")
    if (!params.events?.length) throw new SigningflowInvalidRequestError("events is required.")
    if (params.httpConfig?.auth?.toUpperCase() === "NONE") {
      throw new SigningflowInvalidRequestError("auth NONE has no signature. Leave httpConfig empty.")
    }
    if (params.httpConfig) throw new SigningflowInvalidRequestError("Leave httpConfig empty so the destination uses HMAC.")
    return this.sender.call<WebhookUrl>({
      operation: OPERATIONS.WebhookUrlService_AddWebhookUrl,
      idempotencyKey: params.idempotencyKey,
      body: {
        webhookUrl: {
          displayName,
          httpRequestUri: params.httpRequestUri,
          events: params.events,
        },
      },
    })
  }

  async retrieve(name: string): Promise<WebhookUrl> {
    const destination = requireName(name, WEBHOOK_URL, "webhook url must look like webhookUrls/{id}.")
    const viewed = await this.sender.call<WebhookUrl>({
      operation: OPERATIONS.WebhookUrlService_ViewWebhookUrl,
      pathParams: { name: destination },
    })
    const record = { ...(asRecord(viewed) ?? {}) }
    delete record.signing_secret
    delete record.signingSecret
    return record
  }

  async test(name: string): Promise<WebhookUrl> {
    const destination = requireName(name, WEBHOOK_URL, "webhook url must look like webhookUrls/{id}.")
    return this.sender.call<WebhookUrl>({
      operation: OPERATIONS.WebhookUrlService_TestWebhookUrl,
      pathParams: { name: destination },
      body: {},
    })
  }
}

export class WebhookDeliveries {
  constructor(private readonly sender: RequestSender) {}

  async list(params?: { pageSize?: number; pageToken?: string }): Promise<ApiList<WebhookDelivery>> {
    const pageSize = pageSizeOf(params?.pageSize)
    const load = (pageToken?: string) => this.listPage(pageSize, pageToken)
    return pageOf(await load(params?.pageToken), (pageToken) => load(pageToken))
  }

  async retrieve(name: string): Promise<WebhookDelivery> {
    const delivery = requireName(name, DELIVERY, "webhook delivery must look like webhooks/{id}.")
    return this.sender.call<WebhookDelivery>({
      operation: OPERATIONS.WebhookService_ViewWebhook,
      pathParams: { name: delivery },
    })
  }

  private async listPage(pageSize: number, pageToken?: string) {
    const body = await this.sender.call<Record<string, unknown>>({
      operation: OPERATIONS.WebhookService_ListWebhooks,
      pathParams: { parent: "webhooks" },
      query: { pageSize: String(pageSize), pageToken },
    })
    return { data: listItems<WebhookDelivery>(body, "webhooks"), next_page_token: nextToken(body) }
  }
}

function pageSizeOf(value: number | undefined): number {
  const size = value ?? 10
  if (!Number.isInteger(size) || size < 1 || size > 1000) {
    throw new SigningflowInvalidRequestError("pageSize must be a whole number from 1 to 1000.")
  }
  return size
}

function requireName(name: string, pattern: RegExp, message: string): string {
  const trimmed = name.trim()
  if (!pattern.test(trimmed)) throw new SigningflowInvalidRequestError(message)
  return trimmed
}

export function signingSecretOf(body: unknown): string {
  const record = asRecord(body)
  return text(record?.signing_secret) || text(record?.signingSecret)
}
