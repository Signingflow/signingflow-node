import { constants, open, realpath } from "node:fs/promises"
import { basename, dirname, join, relative, resolve, sep } from "node:path"

export async function readJailed(root: string, requested: string, maxBytes: number): Promise<Uint8Array> {
  const base = await realpath(root)
  const resolved = resolve(base, requested)
  const parentReal = await realpath(dirname(resolved))
  if (escapes(base, parentReal)) throw new Error("outside root")
  const leaf = basename(resolved)
  if (!leaf || leaf === "." || leaf === "..") throw new Error("outside root")
  const path = join(parentReal, leaf)
  if (escapes(base, path) || relative(base, path) === "") throw new Error("outside root")
  const flags = constants.O_RDONLY | (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0)
  const handle = await open(path, flags)
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error("not a file")
    if (info.nlink > 1) throw new Error("hard link")
    if (info.size > maxBytes) throw new Error("too large")
    const bytes = Buffer.alloc(info.size)
    let offset = 0
    while (offset < info.size) {
      const { bytesRead } = await handle.read(bytes, offset, info.size - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    return new Uint8Array(bytes.subarray(0, offset))
  } finally {
    await handle.close()
  }
}

function escapes(base: string, target: string): boolean {
  return relative(base, target).split(sep).includes("..")
}
