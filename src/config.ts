import { SigningflowError } from "./errors.js"
import { SOURCE } from "./version.js"

export type SigningflowEnv = "sandbox" | "live"

export interface SigningflowConfig {
  workspaceId: string
  env: SigningflowEnv | "SANDBOX" | "LIVE"
  baseUrl?: string
  allowCustomBaseUrl?: boolean
  timeout?: number
  maxNetworkRetries?: number
  channel?: string
  funnel?: string
  uploadHosts?: string[]
  uploadRoot?: string
  fetch?: typeof fetch
}

export interface ResolvedConfig {
  apiKey: string
  workspaceId: string
  env: "SANDBOX" | "LIVE"
  baseUrl: string
  timeout: number
  maxNetworkRetries: number
  channel?: string
  funnel?: string
  uploadHosts: string[]
  uploadRoot?: string
  source: string
  fetch: typeof fetch
}

const DEFAULT_UPLOAD_HOSTS = ["storage.googleapis.com"]
const OFFICIAL_HOST = "api.signingflow.com"

export function resolveConfig(apiKey: string, options: SigningflowConfig): ResolvedConfig {
  if (!apiKey?.trim()) throw new SigningflowError("API key is required.")
  if (!options?.workspaceId?.trim()) throw new SigningflowError("workspaceId is required.")
  const baseUrl = (options.baseUrl?.trim() || "https://api.signingflow.com").replace(/\/$/, "")
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new SigningflowError("baseUrl must be an absolute URL.")
  }
  if (parsed.protocol !== "https:") throw new SigningflowError("baseUrl must be https.")
  if (parsed.username || parsed.password) throw new SigningflowError("baseUrl must not include a username or password.")
  if (parsed.hostname !== OFFICIAL_HOST && !options.allowCustomBaseUrl) {
    throw new SigningflowError("baseUrl host must be api.signingflow.com, or set allowCustomBaseUrl.")
  }
  const timeout = options.timeout ?? 30_000
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new SigningflowError("timeout must be a positive number of milliseconds.")
  }
  const maxNetworkRetries = options.maxNetworkRetries ?? 2
  if (!Number.isInteger(maxNetworkRetries) || maxNetworkRetries < 0) {
    throw new SigningflowError("maxNetworkRetries must be a whole number of zero or more.")
  }
  return {
    apiKey: apiKey.trim(),
    workspaceId: options.workspaceId.trim(),
    env: normalizeEnv(options.env),
    baseUrl,
    timeout,
    maxNetworkRetries,
    channel: blankToUndefined(options.channel),
    funnel: blankToUndefined(options.funnel),
    uploadHosts: uploadHostsOf(options.uploadHosts),
    uploadRoot: blankToUndefined(options.uploadRoot),
    source: SOURCE,
    fetch: options.fetch ?? globalThis.fetch,
  }
}

function normalizeEnv(env: SigningflowConfig["env"]): "SANDBOX" | "LIVE" {
  if (env === "sandbox" || env === "SANDBOX") return "SANDBOX"
  if (env === "live" || env === "LIVE") return "LIVE"
  throw new SigningflowError("env must be sandbox or live.")
}

function uploadHostsOf(hosts: string[] | undefined): string[] {
  const list = (hosts ?? DEFAULT_UPLOAD_HOSTS).map((host) => host.trim().toLowerCase()).filter(Boolean)
  for (const host of list) {
    const dots = host.split(".").length - 1
    if (dots < 2 || host.startsWith(".") || host.endsWith(".") || host.includes("..")) {
      throw new SigningflowError("Each uploadHosts entry must be a specific host, not a public suffix.")
    }
  }
  return list
}

function blankToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}
