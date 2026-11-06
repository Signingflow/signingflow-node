import { spawnSync } from "node:child_process"
import { readdirSync } from "node:fs"
import { join } from "node:path"

function testFiles(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...testFiles(path))
    else if (entry.name.endsWith(".test.ts")) found.push(path)
  }
  return found
}

const help = spawnSync(process.execPath, ["--help"], { encoding: "utf8" })
const supported = `${help.stdout}\n${help.stderr}`.includes("--test-coverage-lines")
const args = ["--experimental-test-coverage"]
if (supported) {
  args.push(
    "--test-coverage-lines=80",
    "--test-coverage-branches=80",
    "--test-coverage-functions=80",
    "--test-coverage-include=src/**/*.ts",
  )
}
args.push("--import", "tsx", "--test", ...testFiles("test"))
const result = spawnSync(process.execPath, args, { stdio: "inherit" })
process.exit(result.status ?? 1)
