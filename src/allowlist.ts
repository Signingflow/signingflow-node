export interface OperationSpec {
  operationId: string
  http: "GET" | "POST" | "PATCH"
  path: string
  idempotent: boolean
  capability: string
}

export const OPERATIONS = {
  StorageService_BatchAddStorage: spec("StorageService_BatchAddStorage", "POST", "/v1/storages:batchAddStorage", true, "storage:write"),
  StorageService_BatchAcknowledgeUpload: spec("StorageService_BatchAcknowledgeUpload", "POST", "/v1/storages:batchAcknowledgeUpload", true, "storage:write"),
  EnvelopeService_AddEnvelope: spec("EnvelopeService_AddEnvelope", "POST", "/v1/envelopes:addEnvelope", true, "envelope:write"),
  EnvelopeService_ViewEnvelope: spec("EnvelopeService_ViewEnvelope", "GET", "/v1/{name_1}:view", false, "envelope:read"),
  EnvelopeService_UpdateEnvelope: spec("EnvelopeService_UpdateEnvelope", "PATCH", "/v1/{envelope.name}", false, "envelope:write"),
  EnvelopeService_SendEnvelope: spec("EnvelopeService_SendEnvelope", "POST", "/v1/{name}:send", true, "envelope:send"),
  EnvelopeService_ListEnvelopes: spec("EnvelopeService_ListEnvelopes", "GET", "/v1/{parent}", false, "envelope:read"),
  EnvelopeService_RemindEnvelopeSigners: spec("EnvelopeService_RemindEnvelopeSigners", "POST", "/v1/{name}:remind", false, "envelope:send"),
  EnvelopeService_DownloadEnvelope: spec("EnvelopeService_DownloadEnvelope", "GET", "/v1/{name}:download", false, "envelope:read"),
  TemplateService_UseTemplate: spec("TemplateService_UseTemplate", "POST", "/v1/{name}:use", true, "template:write"),
  WebhookUrlService_AddWebhookUrl: spec("WebhookUrlService_AddWebhookUrl", "POST", "/v1/webhookUrls:add", true, "webhook:write"),
  WebhookUrlService_ViewWebhookUrl: spec("WebhookUrlService_ViewWebhookUrl", "GET", "/v1/{name}:view", false, "webhook:read"),
  WebhookUrlService_TestWebhookUrl: spec("WebhookUrlService_TestWebhookUrl", "POST", "/v1/{name}:test", false, "webhook:write"),
  WebhookService_ListWebhooks: spec("WebhookService_ListWebhooks", "GET", "/v1/{parent}", false, "webhook:read"),
  WebhookService_ViewWebhook: spec("WebhookService_ViewWebhook", "GET", "/v1/{name}:view", false, "webhook:read"),
} as const satisfies Record<string, OperationSpec>

function spec(operationId: string, http: OperationSpec["http"], path: string, idempotent: boolean, capability: string): OperationSpec {
  return { operationId, http, path, idempotent, capability }
}
