/**
 * Image processing for the E87 badge.
 *
 * The badge displays a plain JPEG on a 368×368 round panel. There is no
 * officially documented maximum file size; in practice tens of KB upload fine.
 * To stay safely within that envelope we center-crop to a square, scale to
 * 368×368, then step the JPEG quality down until the encoded size fits a byte
 * budget.
 */

import { E87_IMAGE_SIZE } from './e87-client'
import { buildMjpgAvi } from './avi'
import { gifToFrames, imagesToFrames, videoToFrames, fpsFromFrames, type BadgeFrame } from './media-frames'
import { resolveFit, evenlySpacedIndices, type FitPlan } from './frame-budget'

/** Conservative upload budget. Well within sizes proven to work on hardware. */
export const TARGET_MAX_BYTES = 60000

/**
 * Whole-AVI budget, and a HARD limit — not advice.
 *
 * Measured on hardware 2026-07-30: 449 KB and 558 KB animations play; 890 KB
 * and 1.72 MB upload without a single protocol error and then display nothing.
 * The true ceiling is somewhere in 558 KB–890 KB and not yet narrowed, so this
 * sits just under the largest size confirmed to work.
 *
 * Raising it needs a hardware capture, not a guess — an animation over the real
 * limit fails silently, which is the one failure mode a user cannot diagnose.
 */
export const TARGET_MAX_ANIMATION_BYTES = 550000

/**
 * Frame ceiling, independent of bytes. 49 frames are confirmed to play and 120
 * are confirmed not to — but those runs were also 558 KB and 890 KB, so frames
 * and bytes are still confounded and this may be doing nothing. Kept as a
 * separate knob so that, once a many-frames/small-bytes capture exists, the two
 * limits can be tuned apart instead of one masking the other.
 */
export const MAX_ANIMATION_FRAMES = 120

const QUALITY_STEPS = [0.9, 0.85, 0.8, 0.72, 0.64, 0.56, 0.48, 0.4, 0.32, 0.25]

export interface EncodedImage {
  jpeg: Uint8Array
  previewUrl: string
  width: number
  height: number
  quality: number
  /** true if even the lowest quality could not fit maxBytes */
  overBudget: boolean
  maxBytes: number
}

/** Load a File, center-crop to a square, scale to 368×368, encode as JPEG within a byte budget. */
export async function fileToBadgeJpeg(file: File, maxBytes = TARGET_MAX_BYTES): Promise<EncodedImage> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error('이미지를 읽을 수 없습니다 (지원하지 않는 형식일 수 있어요).')
  }

  const side = Math.min(bitmap.width, bitmap.height)
  const sx = (bitmap.width - side) / 2
  const sy = (bitmap.height - side) / 2

  const canvas = document.createElement('canvas')
  canvas.width = E87_IMAGE_SIZE
  canvas.height = E87_IMAGE_SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 2D 컨텍스트를 만들 수 없습니다.')
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, E87_IMAGE_SIZE, E87_IMAGE_SIZE)
  bitmap.close()

  let chosen: Blob | null = null
  let chosenQ = QUALITY_STEPS[0]
  for (const q of QUALITY_STEPS) {
    const blob = await encodeJpeg(canvas, q)
    chosen = blob
    chosenQ = q
    if (blob.size <= maxBytes) break
  }
  if (!chosen) throw new Error('JPEG 인코딩에 실패했습니다.')

  const jpeg = new Uint8Array(await chosen.arrayBuffer())
  const previewUrl = URL.createObjectURL(chosen)
  return {
    jpeg,
    previewUrl,
    width: E87_IMAGE_SIZE,
    height: E87_IMAGE_SIZE,
    quality: chosenQ,
    overBudget: jpeg.length > maxBytes,
    maxBytes,
  }
}

function encodeJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('JPEG 인코딩 실패'))), 'image/jpeg', quality),
  )
}

// ── Animation (GIF / slideshow → MJPG-AVI) ───────────────────

/** Animations need smaller per-frame JPEGs than a single still, so start lower. */
const ANIM_QUALITY_STEPS = [0.8, 0.7, 0.6, 0.5, 0.42, 0.35, 0.28, 0.22]

export interface EncodedAnimation {
  aviBytes: Uint8Array
  /** Object URL of the first frame (== frameUrls[0]); a static <img> fallback. */
  previewUrl: string
  /** Object URL per frame (the exact JPEGs in the AVI), for an animated preview. */
  frameUrls: string[]
  frameCount: number
  /** Frames the source had before any decimation — equals frameCount if none. */
  sourceFrameCount: number
  fps: number
  sizeBytes: number
  quality: number
  maxBytes: number
}

export interface AnimationOpts {
  maxBytes?: number
  maxFrames?: number
}

/** Frames sampled to estimate bytes-per-frame before committing to a full
 *  encode. Three suffices: the two independent q22 hardware captures agree on
 *  bytes/frame within 2% (see src/frame-budget.ts). */
const PROBE_SAMPLES = 3

/** Measure roughly what one frame costs at each quality rung. */
async function probeBytesPerFrame(frames: BadgeFrame[]): Promise<number[]> {
  const idx = evenlySpacedIndices(frames.length, Math.min(PROBE_SAMPLES, frames.length))
  const out: number[] = []
  for (const q of ANIM_QUALITY_STEPS) {
    let total = 0
    for (const i of idx) total += (await encodeJpeg(frames[i].canvas, q)).size
    out.push(total / idx.length)
  }
  return out
}

/** Take `plan.frames` frames, stretching each one's duration so the animation
 *  still runs for the same wall-clock time at a lower frame rate. */
function applyPlan(frames: BadgeFrame[], plan: FitPlan): BadgeFrame[] {
  if (plan.frames >= frames.length) return frames
  const scale = frames.length / plan.frames
  return evenlySpacedIndices(frames.length, plan.frames).map((i) => ({
    canvas: frames[i].canvas,
    durationMs: frames[i].durationMs * scale,
  }))
}

/** Encode every frame at `quality` and mux. */
async function encodeAll(frames: BadgeFrame[], quality: number, fps: number) {
  const blobs: Blob[] = []
  const jpegs: Uint8Array[] = []
  for (const f of frames) {
    const blob = await encodeJpeg(f.canvas, quality)
    blobs.push(blob)
    jpegs.push(new Uint8Array(await blob.arrayBuffer()))
  }
  return { blobs, avi: buildMjpgAvi(jpegs, fps) }
}


/**
 * Mux frames into an MJPG-AVI that is GUARANTEED to fit the byte budget, or
 * throw explaining why it cannot.
 *
 * The old version walked the quality ladder re-encoding every frame at each
 * rung, and when the bottom rung still missed the budget it shipped the
 * oversized file with an `overBudget` flag. On hardware that means a clean
 * upload, minutes of transfer, and a blank badge. Now we probe a few frames,
 * solve for (frames, quality) directly, and encode once — which also cuts the
 * work from up to 8xN encodes to about 1xN.
 *
 * @param allowDecimation false for slideshows, whose frames are distinct images
 *        the user chose. Dropping one would silently deliver a different
 *        slideshow, so there we refuse the job instead.
 */
async function framesToAvi(
  frames: BadgeFrame[],
  allowDecimation: boolean,
  opts: AnimationOpts = {},
): Promise<EncodedAnimation> {
  if (frames.length === 0) throw new Error('프레임이 없습니다.')
  const maxBytes = opts.maxBytes ?? TARGET_MAX_ANIMATION_BYTES
  const maxFrames = opts.maxFrames ?? MAX_ANIMATION_FRAMES
  const sourceFrameCount = frames.length

  // resolveFit owns the plan → encode → verify loop; these capture whatever the
  // last (accepted) encode produced.
  let blobs: Blob[] = []
  let avi: Uint8Array | null = null
  let used: BadgeFrame[] = frames
  let fps = 0

  const plan = await resolveFit(
    {
      frameCount: sourceFrameCount,
      qualities: ANIM_QUALITY_STEPS,
      maxBytes,
      maxFrames,
      allowDecimation,
    },
    () => probeBytesPerFrame(frames),
    async (p) => {
      used = applyPlan(frames, p)
      fps = fpsFromFrames(used)
      const r = await encodeAll(used, p.quality, fps)
      blobs = r.blobs
      avi = r.avi
      return r.avi.length
    },
  )
  if (!plan || !avi) throw notFittableError(allowDecimation, maxBytes)
  const aviBytes: Uint8Array = avi

  // One object URL per frame (the exact bytes muxed into the AVI) so the preview
  // can animate what the badge will actually display. frameUrls[0] == previewUrl.
  const frameUrls = blobs.map((b) => URL.createObjectURL(b))

  return {
    aviBytes,
    previewUrl: frameUrls[0],
    frameUrls,
    frameCount: used.length,
    sourceFrameCount,
    fps,
    sizeBytes: aviBytes.length,
    quality: plan.quality,
    maxBytes,
  }
}

/** Actionable refusal. The user can shorten the source or pick fewer images;
 *  they cannot do anything about a file that uploads and then vanishes. */
function notFittableError(allowDecimation: boolean, maxBytes: number): Error {
  const kb = Math.round(maxBytes / 1024)
  return new Error(
    allowDecimation
      ? `배지 용량(${kb}KB)에 맞출 수 없습니다. 더 짧은 GIF·동영상을 사용해 주세요.`
      : `사진이 너무 많아 배지 용량(${kb}KB)에 맞출 수 없습니다. 장수를 줄여 주세요.`,
  )
}

/** Decode an animated GIF and build an MJPG-AVI for the badge.
 *  Frames are temporal samples, so they may be thinned to fit the budget. */
export async function fileToBadgeAnimation(
  file: File,
  opts: AnimationOpts & { maxFrames?: number } = {},
): Promise<EncodedAnimation> {
  const frames = await gifToFrames(file, { maxFrames: opts.maxFrames })
  return framesToAvi(frames, true, opts)
}

/** Build a slideshow MJPG-AVI from multiple still images.
 *  Decimation is NOT allowed here: every frame is an image the user picked, so
 *  dropping one would quietly deliver a slideshow they did not ask for. */
export async function filesToBadgeAnimation(
  files: File[],
  frameMs = 500,
  opts: AnimationOpts & { maxFrames?: number } = {},
): Promise<EncodedAnimation> {
  const frames = await imagesToFrames(files, frameMs, { maxFrames: opts.maxFrames })
  return framesToAvi(frames, false, opts)
}

/** Sample a video into frames and build an MJPG-AVI for the badge.
 *  Frames are temporal samples, so they may be thinned to fit the budget. */
export async function videoToBadgeAnimation(
  file: File,
  opts: AnimationOpts & { targetFps?: number; maxFrames?: number; maxSeconds?: number } = {},
): Promise<EncodedAnimation> {
  const frames = await videoToFrames(file, {
    targetFps: opts.targetFps,
    maxFrames: opts.maxFrames,
    maxSeconds: opts.maxSeconds,
  })
  return framesToAvi(frames, true, opts)
}
