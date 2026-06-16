/**
 * MJPG AVI muxer for the JieLi AC697 E87/L8 LED badge.
 *
 * Ports the hardware-verified layout from hybridherbst/web-bluetooth-e87
 * (web/src/avi-builder.ts, MIT). The byte structure matches what the official
 * iOS app sends to the device, cross-checked against that repo's
 * protocol-understanding/dump_avi_header.py dump of a real session AVI:
 *
 *   offset 0      RIFF 'AVI '
 *   offset 12     LIST 'hdrl'
 *   offset 24       avih            (56-byte main header)
 *   offset 88       LIST 'strl'
 *   offset 100        strh          (56-byte video stream header, vids/MJPG)
 *   offset 164        strf          (40-byte BITMAPINFOHEADER, MJPG/24bpp)
 *   offset 212        JUNK          (4120-byte OpenDML super-index placeholder)
 *   offset 4340     vprp            (68-byte video properties)
 *   offset ~4416    JUNK            (260-byte padding)
 *   offset 4684     LIST 'INFO'
 *   offset 4696       ISFT          (software tag)
 *   offset 4716     JUNK            (alignment pad so movi lands at 5742)
 *   offset 5742     LIST 'movi'
 *                     00dc frame0, 00dc frame1, ... (each word-aligned)
 *   ...             idx1            (16 bytes/frame, AVIIF_KEYFRAME)
 *
 * ALL AVI integers are LITTLE-ENDIAN (unlike the badge BLE protocol, which is
 * big-endian). Browser-only: DataView/Uint8Array, no Node Buffer.
 */

/** Native panel resolution of the E87/L8 badge. */
export const E87_AVI_SIZE = 368

const FOURCC = (s: string): Uint8Array => {
  const a = new Uint8Array(4)
  for (let i = 0; i < 4; i++) a[i] = s.charCodeAt(i) & 0xff
  return a
}

const u32le = (v: number): Uint8Array => {
  const a = new Uint8Array(4)
  // >>> keeps the value unsigned for the high bit (e.g. 0xffffffff).
  a[0] = v & 0xff
  a[1] = (v >>> 8) & 0xff
  a[2] = (v >>> 16) & 0xff
  a[3] = (v >>> 24) & 0xff
  return a
}

const u16le = (v: number): Uint8Array => {
  const a = new Uint8Array(2)
  a[0] = v & 0xff
  a[1] = (v >>> 8) & 0xff
  return a
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

/** RIFF chunks must be word-aligned: pad the *payload* to even length. */
function padEven(data: Uint8Array): Uint8Array {
  return data.length & 1 ? concat(data, new Uint8Array(1)) : data
}

/** ckID + ckSize(LE, unpadded length) + padded payload. */
function makeChunk(id: string, data: Uint8Array): Uint8Array {
  return concat(FOURCC(id), u32le(data.length), padEven(data))
}

/** 'LIST' + listSize + listType + children. listSize counts listType + children. */
function makeList(type: string, ...children: Uint8Array[]): Uint8Array {
  const inner = concat(FOURCC(type), ...children)
  return concat(FOURCC('LIST'), u32le(inner.length), inner)
}

/**
 * Assemble motion-JPEG frames into an AVI the E87/L8 badge can play.
 *
 * @param frames  Pre-encoded JPEG frames (each FF D8 ... FF D9), 368x368.
 * @param fps     Playback rate. Sets dwMicroSecPerFrame = round(1e6/fps),
 *                dwRate = fps, dwScale = 1.
 * @returns       Complete .avi file bytes.
 */
export function buildMjpgAvi(frames: Uint8Array[], fps: number): Uint8Array {
  if (!frames.length) throw new Error('buildMjpgAvi: at least one frame is required')
  if (!(fps > 0)) throw new Error('buildMjpgAvi: fps must be a positive number')

  const width = E87_AVI_SIZE
  const height = E87_AVI_SIZE
  const totalFrames = frames.length
  const usecPerFrame = Math.round(1_000_000 / fps)
  let maxFrameSize = 0
  for (const f of frames) if (f.length > maxFrameSize) maxFrameSize = f.length

  // ── avih (56 bytes) ─────────────────────────────────────────────────────
  const avih = makeChunk(
    'avih',
    concat(
      u32le(usecPerFrame), // dwMicroSecPerFrame
      u32le(25_000), // dwMaxBytesPerSec
      u32le(0), // dwPaddingGranularity
      u32le(0x0910), // dwFlags: AVIF_HASINDEX | AVIF_ISINTERLEAVED
      u32le(totalFrames), // dwTotalFrames
      u32le(0), // dwInitialFrames
      u32le(1), // dwStreams
      u32le(0x0010_0000), // dwSuggestedBufferSize (1 MiB)
      u32le(width), // dwWidth
      u32le(height), // dwHeight
      new Uint8Array(16), // dwReserved[4]
    ),
  )

  // ── strh — video stream header (56 bytes) ────────────────────────────────
  const strh = makeChunk(
    'strh',
    concat(
      FOURCC('vids'), // fccType
      FOURCC('MJPG'), // fccHandler
      u32le(0), // dwFlags
      u16le(0), // wPriority
      u16le(0), // wLanguage
      u32le(0), // dwInitialFrames
      u32le(1), // dwScale
      u32le(fps), // dwRate  -> rate/scale = fps
      u32le(0), // dwStart
      u32le(totalFrames), // dwLength (frames)
      u32le(maxFrameSize), // dwSuggestedBufferSize
      u32le(0xffffffff), // dwQuality (-1 = default)
      u32le(0), // dwSampleSize
      u16le(0), // rcFrame.left
      u16le(0), // rcFrame.top
      u16le(width), // rcFrame.right
      u16le(height), // rcFrame.bottom
    ),
  )

  // ── strf — BITMAPINFOHEADER (40 bytes) ───────────────────────────────────
  const strf = makeChunk(
    'strf',
    concat(
      u32le(40), // biSize
      u32le(width), // biWidth
      u32le(height), // biHeight
      u16le(1), // biPlanes
      u16le(24), // biBitCount
      FOURCC('MJPG'), // biCompression
      u32le(width * height * 3), // biSizeImage
      u32le(0), // biXPelsPerMeter
      u32le(0), // biYPelsPerMeter
      u32le(0), // biClrUsed
      u32le(0), // biClrImportant
    ),
  )

  // ── JUNK — OpenDML super-index placeholder (4120 bytes) ──────────────────
  // The iOS app reserves this slot; the badge tolerates an empty placeholder.
  // First dword = 0x04, then the '00dc' stream id, rest zero.
  const junkSuper = new Uint8Array(4120)
  junkSuper[0] = 0x04
  junkSuper.set(FOURCC('00dc'), 8)
  const junkSuperChunk = makeChunk('JUNK', junkSuper)

  const strl = makeList('strl', strh, strf, junkSuperChunk)

  // ── vprp — video properties (68 bytes) ───────────────────────────────────
  const vprp = makeChunk(
    'vprp',
    concat(
      u32le(0), // VideoFormatToken
      u32le(0), // VideoStandard
      u32le(fps), // dwVerticalRefreshRate
      u32le(width), // dwHTotalInT
      u32le(height), // dwVTotalInLines
      u32le(1 | (1 << 16)), // dwFrameAspectRatio (1:1)
      u32le(width), // dwFrameWidthInPixels
      u32le(height), // dwFrameHeightInLines
      u32le(1), // nbFieldPerFrame
      // VIDEO_FIELD_DESC[0]:
      u32le(width), // CompressedBMWidth
      u32le(height), // CompressedBMHeight
      u32le(width), // ValidBMWidth
      u32le(height), // ValidBMHeight
      u32le(0), // ValidBMXOffset
      u32le(0), // ValidBMYOffset
      u32le(0), // VideoXOffsetInT
      u32le(0), // VideoYValidStartLine
    ),
  )

  // ── JUNK padding (260 bytes) ─────────────────────────────────────────────
  const junkPad = makeChunk('JUNK', new Uint8Array(260))

  const hdrl = makeList('hdrl', avih, strl, vprp, junkPad)

  // ── LIST 'INFO' with ISFT software tag ───────────────────────────────────
  const isftStr = 'AviBuilder\0'
  const isftBytes = new Uint8Array(isftStr.length)
  for (let i = 0; i < isftStr.length; i++) isftBytes[i] = isftStr.charCodeAt(i)
  const info = makeList('INFO', makeChunk('ISFT', isftBytes))

  // ── JUNK alignment pad so 'movi' begins at the reference offset (5742) ────
  // 12 = RIFF header (8) + 'AVI ' fourcc (4). The trailing 8 accounts for the
  // alignment JUNK chunk's own ckID+ckSize header.
  const TARGET_MOVI_OFFSET = 5742
  const headerSoFar = 12 + hdrl.length + info.length
  if (headerSoFar + 8 > TARGET_MOVI_OFFSET) {
    throw new Error(`buildMjpgAvi: headers (${headerSoFar}) exceed movi target ${TARGET_MOVI_OFFSET}`)
  }
  const junkAlignSize = TARGET_MOVI_OFFSET - headerSoFar - 8
  const junkAlign = makeChunk('JUNK', new Uint8Array(junkAlignSize))

  // Hard guard: 'movi' must land exactly at the reference offset. makeChunk pads
  // odd payloads (recording the unpadded ckSize), so an odd junkAlignSize would
  // silently shift movi by one byte — fail loudly rather than emit a bad file.
  const moviOffset = 12 + hdrl.length + info.length + junkAlign.length
  if (moviOffset !== TARGET_MOVI_OFFSET) {
    throw new Error(`buildMjpgAvi: movi misaligned (${moviOffset} != ${TARGET_MOVI_OFFSET})`)
  }

  // ── LIST 'movi' — frame chunks, each padded to even length ────────────────
  const moviChildren: Uint8Array[] = new Array(totalFrames)
  for (let i = 0; i < totalFrames; i++) moviChildren[i] = makeChunk('00dc', frames[i])
  const movi = makeList('movi', ...moviChildren)

  // ── idx1 — legacy index (16 bytes/frame) ──────────────────────────────────
  // Offsets are relative to the start of the movi LIST *data* (i.e. the dword
  // following the 'movi' fourcc), so the first entry is at 4.
  const idx1Entries: Uint8Array[] = new Array(totalFrames)
  let moviDataOffset = 4
  for (let i = 0; i < totalFrames; i++) {
    const len = frames[i].length
    idx1Entries[i] = concat(
      FOURCC('00dc'),
      u32le(0x10), // AVIIF_KEYFRAME
      u32le(moviDataOffset), // dwChunkOffset (from movi data start)
      u32le(len), // dwChunkLength (unpadded payload)
    )
    moviDataOffset += 8 + len + (len & 1) // 'ckID'+size header + payload + pad
  }
  const idx1 = makeChunk('idx1', concat(...idx1Entries))

  // ── RIFF container ────────────────────────────────────────────────────────
  const riffContent = concat(FOURCC('AVI '), hdrl, info, junkAlign, movi, idx1)
  return concat(FOURCC('RIFF'), u32le(riffContent.length), riffContent)
}
