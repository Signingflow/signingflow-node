import { resolveConfig, type SigningflowConfig } from "./config.js"
import { RequestSender } from "./RequestSender.js"
import { Envelopes, Files, Templates } from "./resources/resources.js"
import { WebhookDeliveries, WebhookUrls } from "./resources/webhooks.js"
import { Webhooks } from "./Webhooks.js"

export class Signingflow {
  readonly files: Files
  readonly envelopes: Envelopes
  readonly templates: Templates
  readonly webhookUrls: WebhookUrls
  readonly webhookDeliveries: WebhookDeliveries
  readonly webhooks: Webhooks

  constructor(apiKey: string, options: SigningflowConfig) {
    const config = resolveConfig(apiKey, options)
    const sender = new RequestSender(config)
    this.files = new Files(sender, config)
    this.templates = new Templates(sender)
    this.envelopes = new Envelopes(sender, this.files, this.templates)
    this.webhookUrls = new WebhookUrls(sender)
    this.webhookDeliveries = new WebhookDeliveries(sender)
    this.webhooks = new Webhooks()
  }
}
