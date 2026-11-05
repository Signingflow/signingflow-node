# signingflow

Node.js SDK for the Signingflow calls used to send a document, read envelope status, and receive webhooks.

The package talks to `https://api.signingflow.com`. Keep the API key on your server.

```bash
npm install github:Signingflow/signingflow-node
```

The package name is `signingflow`. Install it from [GitHub](https://github.com/Signingflow/signingflow-node) until it is published on npm.

```js
import { Signingflow } from "signingflow"

const signingflow = new Signingflow(process.env.SIGNINGFLOW_API_KEY, {
  workspaceId: process.env.SIGNINGFLOW_WORKSPACE_ID,
  env: "sandbox",
})

const envelope = await signingflow.envelopes.sendDocument({
  title: "NDA",
  file: new Uint8Array(pdfBytes),
  filename: "contract.pdf",
  recipients: [{ name: "Ada Lovelace", email: "ada@example.com" }],
  message: "Please sign",
})
```

`env` is `sandbox` or `live`. The client always sends `X-Request-Env`. A missing environment header is treated as live by the API.

`baseUrl` must be `https`. The host is `api.signingflow.com` unless `allowCustomBaseUrl` is set. A username or password on the URL is rejected.

A string `file` is read only from `uploadRoot`. That directory must be one this process writes. The open refuses a symlink, a hard link, and a path that leaves the directory, and it checks the size before reading. Pass `Uint8Array` when the application already has the bytes. Do not pass a path from a request field.

## Send and read

`envelopes.prepareDraft` stores one PDF and creates a draft. It does not email anyone.

`envelopes.sendDocument` stores the PDF, creates the draft, adds the recipients to the first document, and sends. `envelopes.sendFromTemplate` starts from `templates/{id}`.

If update or send fails, the error includes `envelopeName` for the draft that was saved. After a timeout, the client returns the envelope only when `sent_time` is within two minutes after the call started and not more than a minute ahead of this clock. An older or far-future timestamp is an error.

`envelopes.list({ directory: "needAction" })` and `directory: "waitingOthers"` read pages of 10. `pageSize` can be from 1 to 1000.

`envelopes.downloadCompleted(name)` reads the envelope first. It requests the download URL only when the state is `COMPLETED`. The download call returns JSON with `uri`, `download_time`, and `etag`. This client does not GET `uri`. Treat that URL as untrusted until your application checks the host. Do not send the API key to it.

`envelopes.remind(name)` notifies people who can still sign. The call is not idempotent.

## Idempotency

Creates and sends send a UUID `idempotencyKey` in the JSON body. The same key is stored for the whole environment. A repeat returns HTTP 409 and does not return the original resource. The SDK throws `SigningflowIdempotencyError` with `resourceName` when the error includes one. It does not treat that response as success.

Pass the same `idempotencyKey` only to retry one request after a timeout. `update` and `remind` are not retried automatically.

## Webhooks

```js
const destination = await signingflow.webhookUrls.create({
  displayName: "Envelope events",
  httpRequestUri: "https://example.com/webhooks/signingflow",
  events: ["DOC_ENVELOPE_COMPLETED"],
})
```

Store `destination.signing_secret` from that response. A later `retrieve` does not include it. Do not set `httpConfig`; an empty config is stored as HMAC. `auth: "NONE"` is rejected.

```js
const { payload, bodySha256 } = signingflow.webhooks.constructEvent(rawBody, signatureHeader, secret, {
  previousSecret,
  previousSignature,
})
```

The signature is lowercase hex HMAC-SHA256 of the raw body. There is no timestamp. Compare `X-Signingflow-Signature` or `X-Webhook-Signature`. During a grace window, also pass the previous header and secret. Parse JSON only after the MAC matches. `bodySha256` is the SHA-256 of those raw bytes. Store it and reject a delivery you have already seen. Do not hash the parsed object or a re-serialized body. A captured request stays valid until you record that hash or the secret rotates.

## Errors

| Class | When |
| --- | --- |
| `SigningflowAuthenticationError` | HTTP 401 |
| `SigningflowPermissionError` | HTTP 403 |
| `SigningflowIdempotencyError` | HTTP 409 for a used idempotency key |
| `SigningflowRateLimitError` | HTTP 429. `retryAfter` is the RFC3339 `rate-limit-retry-after` time |
| `SigningflowInvalidRequestError` | Other HTTP 4xx |
| `SigningflowAPIError` | HTTP 5xx |
| `SigningflowConnectionError` | The API could not be reached, or the call timed out |
| `SigningflowSignatureVerificationError` | A webhook MAC did not match |

Uploads use a presigned HTTPS PUT to `storage.googleapis.com` with `Content-Type` and `x-goog-if-generation-match: 0`. The URL lives for about 60 seconds. Each `uploadHosts` entry is one host, such as `files.example.com`, not a public suffix such as `com` or `example.com`. The client accepts that host and its subdomains. An entry with fewer than two dots is rejected. A successful upload is HTTP 200–299, or 412 when the object already exists. A redirect is not followed.
