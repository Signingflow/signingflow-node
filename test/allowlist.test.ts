import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { OPERATIONS } from "../src/allowlist.js"

test("operation constants match resources/allowlist.json", () => {
  const path = fileURLToPath(new URL("../resources/allowlist.json", import.meta.url))
  const allowlist = JSON.parse(readFileSync(path, "utf8")) as { operations: Array<Record<string, unknown>> }
  assert.equal(allowlist.operations.length, Object.keys(OPERATIONS).length)
  for (const operation of allowlist.operations) {
    const local = OPERATIONS[operation.operationId as keyof typeof OPERATIONS]
    assert.ok(local)
    assert.equal(local.http, operation.http)
    assert.equal(local.path, operation.path)
    assert.equal(local.idempotent, operation.idempotent)
    assert.equal(local.capability, operation.capability)
  }
})
