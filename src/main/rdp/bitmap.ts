// xrdp pads bitmap rows to a multiple of 4 pixels and says so through width versus the destination
// rectangle. IronRDP takes the rectangle's width as the row length, so the picture comes out slanted.
// Bitmaps with interleaved RLE are therefore unpacked here, cropped to the rectangle and passed on
// uncompressed. Anything else goes through untouched: RemoteFX from Windows never comes this way.

const BITMAP_COMPRESSION = 0x0001
const NO_BITMAP_COMPRESSION_HDR = 0x0400

/** Interleaved RLE (MS-RDPBCGR 2.2.9.1.1.3.1.2.4). Rows come out bottom-up, as they went in. */
export function decompressRle(src: Buffer, width: number, height: number, bytes: number): Buffer {
  const stride = width * bytes
  const dst = Buffer.alloc(stride * height)
  const white = bytes === 2 ? 0xffff : bytes === 1 ? 0xff : 0xffffff
  let fg = white
  let insertFg = false
  let s = 0
  let d = 0

  const u8 = (): number => {
    if (s >= src.length) throw new Error('RLE: out of input')
    return src[s++]
  }
  const pixelIn = (): number => {
    if (s + bytes > src.length) throw new Error('RLE: out of input')
    const v = src.readUIntLE(s, bytes)
    s += bytes
    return v
  }
  const put = (v: number): void => {
    if (d + bytes > dst.length) throw new Error('RLE: too much output')
    dst.writeUIntLE(v, d, bytes)
    d += bytes
  }
  const above = (): number => (d < stride ? 0 : dst.readUIntLE(d - stride, bytes))
  const fgbg = (mask: number, count: number): void => {
    for (let bit = 0; bit < count; bit++) put(mask & (1 << bit) ? above() ^ fg : above())
  }
  const fgbgImage = (run: number): void => {
    while (run > 0) {
      const n = Math.min(run, 8)
      fgbg(u8(), n)
      run -= n
    }
  }

  while (s < src.length) {
    const b = u8()
    const code = (b & 0xc0) !== 0xc0 ? b >> 5 : (b & 0xf0) === 0xf0 ? b : b >> 4
    const mega = (): number => {
      const lo = u8()
      return lo | (u8() << 8)
    }
    const regular = (): number => (b & 0x1f) || u8() + 32
    const lite = (): number => (b & 0x0f) || u8() + 16

    if (code === 0x00 || code === 0xf0) {
      let run = code === 0 ? regular() : mega()
      if (insertFg && run > 0) {
        put(above() ^ fg)
        run--
      }
      while (run-- > 0) put(above())
      insertFg = true
      continue
    }
    insertFg = false
    switch (code) {
      case 0x01:
      case 0xf1:
      case 0x0c:
      case 0xf6: {
        let run = code === 0x01 ? regular() : code === 0x0c ? lite() : mega()
        if (code === 0x0c || code === 0xf6) fg = pixelIn()
        while (run-- > 0) put(above() ^ fg)
        break
      }
      case 0x0e:
      case 0xf8: {
        let run = code === 0x0e ? lite() : mega()
        const one = pixelIn()
        const two = pixelIn()
        while (run-- > 0) {
          put(one)
          put(two)
        }
        break
      }
      case 0x03:
      case 0xf3: {
        let run = code === 0x03 ? regular() : mega()
        const v = pixelIn()
        while (run-- > 0) put(v)
        break
      }
      case 0x02:
        fgbgImage((b & 0x1f) === 0 ? u8() + 1 : (b & 0x1f) * 8)
        break
      case 0xf2:
        fgbgImage(mega())
        break
      case 0x0d: {
        const run = (b & 0x0f) === 0 ? u8() + 1 : (b & 0x0f) * 8
        fg = pixelIn()
        fgbgImage(run)
        break
      }
      case 0xf7: {
        const run = mega()
        fg = pixelIn()
        fgbgImage(run)
        break
      }
      case 0x04:
      case 0xf4: {
        let run = code === 0x04 ? regular() : mega()
        while (run-- > 0) put(pixelIn())
        break
      }
      case 0xf9:
        fgbg(0x03, 8)
        break
      case 0xfa:
        fgbg(0x05, 8)
        break
      case 0xfd:
        put(white)
        break
      case 0xfe:
        put(0)
        break
      default:
        throw new Error(`RLE: unknown code ${b}`)
    }
  }
  return dst
}

const pixelBytes = (bpp: number): number => (bpp === 8 ? 1 : bpp === 15 || bpp === 16 ? 2 : bpp === 24 ? 3 : 0)

/** TS_BITMAP_DATA items, `at` on the first one. Undefined when there is nothing to change or it can't be read. */
function rewriteRects(data: Buffer, at: number, count: number): Buffer[] | undefined {
  const out: Buffer[] = []
  let changed = false
  for (let i = 0; i < count; i++) {
    if (at + 18 > data.length) return undefined
    const left = data.readUInt16LE(at)
    const top = data.readUInt16LE(at + 2)
    const right = data.readUInt16LE(at + 4)
    const bottom = data.readUInt16LE(at + 6)
    const width = data.readUInt16LE(at + 8)
    const height = data.readUInt16LE(at + 10)
    const bpp = data.readUInt16LE(at + 12)
    const flags = data.readUInt16LE(at + 14)
    const length = data.readUInt16LE(at + 16)
    const end = at + 18 + length
    if (end > data.length) return undefined
    const bytes = pixelBytes(bpp)
    const w = right - left + 1
    const h = bottom - top + 1
    if (!(flags & BITMAP_COMPRESSION) || !bytes || w <= 0 || h <= 0 || w > width || h > height) {
      out.push(data.subarray(at, end))
      at = end
      continue
    }
    const body = data.subarray(at + 18 + (flags & NO_BITMAP_COMPRESSION_HDR ? 0 : 8), end)
    const raw = decompressRle(body, width, height, bytes)
    // Row 0 of the data is the bottom of the picture. Uncompressed rows are padded to 4 bytes.
    const stride = (w * bytes + 3) & ~3
    for (let row = 0; row < h; ) {
      // One update holds at most what its 16-bit lengths and a TPKT allow.
      const rows = Math.min(h - row, Math.floor(30000 / stride) || 1)
      const part = Buffer.alloc(18 + rows * stride)
      // Bottom-up in the data, top-down on screen: this part is the bottom-most still to send.
      const partBottom = bottom - row
      part.writeUInt16LE(left, 0)
      part.writeUInt16LE(partBottom - rows + 1, 2)
      part.writeUInt16LE(right, 4)
      part.writeUInt16LE(partBottom, 6)
      part.writeUInt16LE(w, 8)
      part.writeUInt16LE(rows, 10)
      part.writeUInt16LE(bpp, 12)
      part.writeUInt16LE(0, 14)
      part.writeUInt16LE(rows * stride, 16)
      for (let y = 0; y < rows; y++) {
        const from = (y + row) * width * bytes
        raw.copy(part, 18 + y * stride, from, from + w * bytes)
      }
      out.push(part)
      row += rows
    }
    changed = true
    at = end
  }
  return changed ? out : undefined
}

/** Share Data carrying a bitmap update, in plain slow-path form. Returns the PDUs to send instead, or undefined. */
export function fixSlowPathBitmaps(pdu: Buffer): Buffer[] | undefined {
  if (pdu[0] !== 3 || pdu[5] !== 0xf0 || pdu[7] !== 0x68 || pdu.length < 20) return undefined
  const perSize = pdu[13] & 0x80 ? 2 : 1
  const start = 13 + perSize
  const share = pdu.subarray(start)
  // Share Control (6), Share Data header (12), update type (2), count (2)
  if (share.length < 22 || (share.readUInt16LE(2) & 0x0f) !== 7) return undefined
  if (share[14] !== 2 || share[15] !== 0 || share.readUInt16LE(18) !== 1) return undefined // type, compression
  const rects = rewriteRects(share, 22, share.readUInt16LE(20))
  if (!rects) return undefined
  const out: Buffer[] = []
  for (const rect of rects) {
    const header = Buffer.from(share.subarray(0, 22))
    const total = header.length + rect.length
    header.writeUInt16LE(total, 0)
    header.writeUInt16LE(total - 14, 12) // uncompressedLength counts from pduType2
    header.writeUInt16LE(1, 20)
    const per = Buffer.alloc(2)
    per.writeUInt16BE(total | 0x8000)
    const tpkt = Buffer.from([3, 0, 0, 0])
    tpkt.writeUInt16BE(4 + 9 + 2 + total, 2)
    out.push(Buffer.concat([tpkt, pdu.subarray(4, 13), per, header, rect]))
  }
  return out
}

/** Fast-path output, unfragmented and uncompressed: same treatment. */
export function fixFastPathBitmaps(pdu: Buffer): Buffer | undefined {
  if (pdu[0] === 3 || pdu[0] & 0xc0) return undefined // encrypted ones are opened before this
  const start = pdu[1] & 0x80 ? 3 : 2
  const body = pdu.subarray(start)
  const parts: Buffer[] = []
  let changed = false
  for (let at = 0; at < body.length; ) {
    const head = body[at]
    if (head >> 6) return undefined
    if (at + 3 > body.length) return undefined
    const size = body.readUInt16LE(at + 1)
    const data = body.subarray(at + 3, at + 3 + size)
    let rects: Buffer[] | undefined
    if ((head & 0x0f) === 1 && !((head >> 4) & 3) && size >= 4 && data.readUInt16LE(0) === 1) {
      rects = rewriteRects(data, 4, data.readUInt16LE(2))
    }
    if (rects) {
      changed = true
      for (const rect of rects) {
        const update = Buffer.alloc(7)
        update[0] = head
        update.writeUInt16LE(rect.length + 4, 1)
        update.writeUInt16LE(1, 3)
        update.writeUInt16LE(1, 5)
        parts.push(update, rect)
      }
    } else parts.push(body.subarray(at, at + 3 + size))
    at += 3 + size
  }
  if (!changed) return undefined
  // One fast-path PDU can't hold it all if it grew past 32 KB: leave those alone rather than cut them.
  const joined = Buffer.concat(parts)
  if (joined.length + 3 > 0x7fff) return undefined
  const head = Buffer.alloc(3)
  head[0] = pdu[0]
  head.writeUInt16BE((joined.length + 3) | 0x8000, 1)
  return Buffer.concat([head, joined])
}
