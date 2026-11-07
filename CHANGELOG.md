# Changelog

## 0.1.0

First Node.js SDK for sending a document, reading envelope status, downloading a completed file, and verifying webhook signatures.

Install from GitHub with `npm install github:Signingflow/signingflow-node` until the package is on npm.

A query value that contains the API key is rejected, including when that key is percent-encoded. The API host is HTTPS `api.signingflow.com` unless `allowCustomBaseUrl` is set. A file path is read only from `uploadRoot`, and a hard link is rejected. `constructEvent` returns `payload` and `bodySha256` of the raw body. A 409 is an idempotency error only when the body says the key was already used. A timed-out send is returned only when `sent_time` falls in the two minutes after the call started. API responses larger than 8 MB are rejected.
