import { SigningflowInvalidRequestError } from "./errors.js"

const MAX_PAGES = 100

export interface Page<T> {
  data: T[]
  next_page_token?: string
}

export interface ApiList<T> extends Page<T> {
  autoPagingEach(handler: (item: T) => void | Promise<void>): Promise<void>
  autoPagingToArray(options?: { limit?: number }): Promise<T[]>
}

export function pageOf<T>(first: Page<T>, load: (pageToken: string) => Promise<Page<T>>): ApiList<T> {
  return {
    data: first.data,
    next_page_token: first.next_page_token,
    autoPagingEach: (handler) => eachPage(first, load, handler),
    autoPagingToArray: async (options) => {
      const items: T[] = []
      const limit = options?.limit
      await eachPage(first, load, (item) => {
        if (limit !== undefined && items.length >= limit) return false
        items.push(item)
        return limit === undefined || items.length < limit
      })
      return items
    },
  }
}

export function nextToken(body: Record<string, unknown>): string | undefined {
  const value = body.next_page_token ?? body.nextPageToken
  return typeof value === "string" && value ? value : undefined
}

export function listItems<T>(body: Record<string, unknown>, key: string): T[] {
  const list = body[key]
  if (!Array.isArray(list)) return []
  return list.filter((item): item is T => Boolean(item) && typeof item === "object")
}

async function eachPage<T>(
  first: Page<T>,
  load: (pageToken: string) => Promise<Page<T>>,
  handler: (item: T) => void | boolean | Promise<void | boolean>,
): Promise<void> {
  let page = first
  const seen = new Set<string>()
  let pages = 0
  for (;;) {
    for (const item of page.data) {
      const keep = await handler(item)
      if (keep === false) return
    }
    const token = page.next_page_token
    if (!token || seen.has(token)) return
    pages += 1
    if (pages > MAX_PAGES) throw new SigningflowInvalidRequestError("Too many pages.")
    seen.add(token)
    page = await load(token)
  }
}
