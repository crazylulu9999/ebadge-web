/**
 * Structural self-test for buildMjpgAvi. Walks the RIFF tree and asserts the
 * container invariants (no hardware needed). Run: npx tsx tests/avi.selftest.ts
 */
import { buildMjpgAvi } from '../src/avi'

let failed = 0
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) {
    console.log(`✅ ${name}`)
  } else {
    console.error(`❌ ${name} ${detail}`)
    failed++
  }
}

// Fake "JPEG" frames with valid SOI/EOI markers and odd/even lengths to
// exercise word-alignment padding.
const mkFrame = (n: number): Uint8Array => {
  const a = new Uint8Array(n)
  a[0] = 0xff
  a[1] = 0xd8 // SOI
  a[n - 2] = 0xff
  a[n - 1] = 0xd9 // EOI
  return a
}
const frames = [mkFrame(101), mkFrame(64), mkFrame(7)] // odd, even, odd
const fps = 10
const avi = buildMjpgAvi(frames, fps)

const dv = new DataView(avi.buffer, avi.byteOffset, avi.byteLength)
const u32 = (o: number) => dv.getUint32(o, true)
const fourcc = (o: number) => String.fromCharCode(avi[o], avi[o + 1], avi[o + 2], avi[o + 3])

check('RIFF magic', fourcc(0) === 'RIFF')
check('RIFF size = len-8', u32(4) === avi.length - 8, `${u32(4)} vs ${avi.length - 8}`)
check("form type 'AVI '", fourcc(8) === 'AVI ')
check('hdrl LIST at 12', fourcc(12) === 'LIST' && fourcc(20) === 'hdrl')
check('avih at 24', fourcc(24) === 'avih')
check('dwMicroSecPerFrame = round(1e6/fps)', u32(32) === Math.round(1e6 / fps), `${u32(32)}`)
check('dwTotalFrames = frames.length', u32(32 + 16) === frames.length, `${u32(48)}`)
check('strh at 100 (vids/MJPG)', fourcc(100) === 'strh' && fourcc(108) === 'vids' && fourcc(112) === 'MJPG')
check('strf at 164, biCompression MJPG', fourcc(164) === 'strf' && fourcc(172 + 16) === 'MJPG')

// Walk top-level chunks of the RIFF body to find 'movi' and 'idx1'.
let moviOffset = -1
let idx1Offset = -1
let p = 12 // after 'RIFF'+size+'AVI '
while (p + 8 <= avi.length) {
  const id = fourcc(p)
  const size = u32(p + 4)
  if (id === 'LIST') {
    const listType = fourcc(p + 8)
    if (listType === 'movi') moviOffset = p
    p += 8 + size + (size & 1)
  } else {
    if (id === 'idx1') idx1Offset = p
    p += 8 + size + (size & 1)
  }
}

check('movi LIST begins at offset 5742', moviOffset === 5742, `got ${moviOffset}`)
check('idx1 present after movi', idx1Offset > moviOffset && moviOffset > 0, `idx1@${idx1Offset} movi@${moviOffset}`)

// Validate movi child chunks + idx1 entries point at the right frames.
if (moviOffset > 0 && idx1Offset > 0) {
  const moviDataStart = moviOffset + 12 // 'LIST'+size+'movi'
  let mp = moviDataStart
  let allDc = true
  let firstChunkAbs = -1
  for (let i = 0; i < frames.length; i++) {
    const id = fourcc(mp)
    const size = u32(mp + 4)
    if (id !== '00dc') allDc = false
    if (i === 0) firstChunkAbs = mp
    if (size !== frames[i].length) allDc = false
    mp += 8 + size + (size & 1)
  }
  check("every movi child is '00dc' with unpadded frame length", allDc)

  // idx1: 16 bytes/entry; offset relative to movi data start (first entry = 4).
  const idx1Size = u32(idx1Offset + 4)
  check('idx1 size = 16 * frames', idx1Size === 16 * frames.length, `${idx1Size}`)
  const e0 = idx1Offset + 8
  check("idx1[0] id '00dc'", fourcc(e0) === '00dc')
  check('idx1[0] flag AVIIF_KEYFRAME', u32(e0 + 4) === 0x10)
  check('idx1[0] offset = 4 (rel to movi data)', u32(e0 + 8) === 4, `${u32(e0 + 8)}`)
  check('idx1[0] length = frame[0]', u32(e0 + 12) === frames[0].length)
  // The "movi data start + idx offset" must point exactly at the first 00dc chunk.
  check(
    'idx1[0] resolves to first 00dc chunk',
    moviDataStart - 4 + u32(e0 + 8) === firstChunkAbs,
    `${moviDataStart - 4 + u32(e0 + 8)} vs ${firstChunkAbs}`,
  )
  // idx1[2] (third frame) offset check
  const e2 = idx1Offset + 8 + 32
  const expOff2 = 4 + (8 + frames[0].length + (frames[0].length & 1)) + (8 + frames[1].length + (frames[1].length & 1))
  check('idx1[2] offset accumulates padded chunk sizes', u32(e2 + 8) === expOff2, `${u32(e2 + 8)} vs ${expOff2}`)
}

if (failed) {
  console.error(`\n❌ ${failed} AVI structural check(s) failed`)
  process.exit(1)
}
console.log('\n✅ AVI container structure valid')
