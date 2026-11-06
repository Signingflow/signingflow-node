import { spawnSync } from "node:child_process"

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
args.push("--import", "tsx", "--test", "test/**/*.test.ts")
const result = spawnSync(process.execPath, args, { stdio: "inherit" })
process.exit(result.status ?? 1)
