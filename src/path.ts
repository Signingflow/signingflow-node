const SEGMENT = /^[A-Za-z0-9_-]+$/

export function fillPath(template: string, params: Record<string, string>): string {
  return template.replace(/\{([^}]+)\}/g, (_match, token: string) => {
    const name = token.split("=")[0] ?? token
    const short = name.split(".").pop() || name
    const value = params[name] || params[short] || (short === "name" || short.startsWith("name_") ? params.name : undefined)
    if (!value) throw new Error(`missing path param ${short}`)
    const segments = value.split("/")
    if (segments.length === 0 || segments.some((segment) => !SEGMENT.test(segment))) {
      throw new Error(`invalid path param ${short}`)
    }
    return segments.map((segment) => encodeURIComponent(segment)).join("/")
  })
}

export function resolveUrl(baseUrl: string, path: string, query?: Record<string, string | undefined>): URL {
  const base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`)
  const url = new URL(path, base)
  if (url.origin !== base.origin) throw new Error("invalid path")
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== "") url.searchParams.set(key, value)
  }
  return url
}

export function allowedUploadUrl(raw: string, hosts: string[]): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error("upload url rejected")
  }
  if (url.protocol !== "https:") throw new Error("upload url must be https")
  if (url.username || url.password) throw new Error("upload url rejected")
  const host = url.hostname.toLowerCase()
  const allowed = hosts.some((item) => host === item || host.endsWith(`.${item}`))
  if (!allowed) throw new Error("upload host rejected")
  return url
}
