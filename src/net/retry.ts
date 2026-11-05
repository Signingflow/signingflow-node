const MAX_DELAY_MS = 60_000

export function retryDelayMs(retryAfter: string | null, resetAfter: string | null, now = Date.now()): number {
  const when = parseTime(retryAfter) ?? parseTime(resetAfter)
  if (when === undefined) return 0
  return Math.min(Math.max(0, when - now), MAX_DELAY_MS)
}

export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseTime(value: string | null): number | undefined {
  if (!value?.trim()) return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}
