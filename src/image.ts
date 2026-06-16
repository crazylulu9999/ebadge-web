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

/** Conservative upload budget. Well within sizes proven to work on hardware. */
export const TARGET_MAX_BYTES = 60000

/**
 * Conservative whole-AVI budget for animations. The badge's real flash limit
 * for AVIs is undocumented, so this is a heuristic — the UI surfaces the actual
 * size and warns when it is exceeded rather than blocking the upload.
 */
export const TARGET_MAX_ANIMATION_BYTES = 500000

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
  /** Object URL of the first frame (for an <img> preview). */
  previewUrl: string
  frameCount: number
  fps: number
  sizeBytes: number
  quality: number
  /** true if even the lowest quality could not fit maxBytes */
  overBudget: boolean
  maxBytes: number
}

/**
 * Encode drawable frames to JPEGs and mux them into an MJPG-AVI, stepping the
 * per-frame JPEG quality down until the whole file fits the byte budget.
 */
async function framesToAvi(
  frames: BadgeFrame[],
  fps: number,
  maxBytes = TARGET_MAX_ANIMATION_BYTES,
): Promise<EncodedAnimation> {
  if (frames.length === 0) throw new Error('프레임이 없습니다.')

  let chosenAvi: Uint8Array | null = null
  let chosenQ = ANIM_QUALITY_STEPS[0]
  for (const q of ANIM_QUALITY_STEPS) {
    const jpegs: Uint8Array[] = []
    for (const f of frames) {
      const blob = await encodeJpeg(f.canvas, q)
      jpegs.push(new Uint8Array(await blob.arrayBuffer()))
    }
    chosenAvi = buildMjpgAvi(jpegs, fps)
    chosenQ = q
    if (chosenAvi.length <= maxBytes) break
  }
  if (!chosenAvi) throw new Error('AVI 인코딩에 실패했습니다.')

  // Preview from the first frame at the chosen quality.
  const previewBlob = await encodeJpeg(frames[0].canvas, chosenQ)
  const previewUrl = URL.createObjectURL(previewBlob)

  return {
    aviBytes: chosenAvi,
    previewUrl,
    frameCount: frames.length,
    fps,
    sizeBytes: chosenAvi.length,
    quality: chosenQ,
    overBudget: chosenAvi.length > maxBytes,
    maxBytes,
  }
}

/** Decode an animated GIF and build an MJPG-AVI for the badge. */
export async function fileToBadgeAnimation(
  file: File,
  opts: { maxFrames?: number; maxBytes?: number } = {},
): Promise<EncodedAnimation> {
  const frames = await gifToFrames(file, { maxFrames: opts.maxFrames })
  const fps = fpsFromFrames(frames)
  return framesToAvi(frames, fps, opts.maxBytes)
}

/** Build a slideshow MJPG-AVI from multiple still images. */
export async function filesToBadgeAnimation(
  files: File[],
  frameMs = 500,
  opts: { maxBytes?: number; maxFrames?: number } = {},
): Promise<EncodedAnimation> {
  const frames = await imagesToFrames(files, frameMs, { maxFrames: opts.maxFrames })
  // Derive fps from the frames' actual durations so it stays consistent with
  // imagesToFrames' handling of out-of-range frameMs.
  const fps = fpsFromFrames(frames)
  return framesToAvi(frames, fps, opts.maxBytes)
}

/** Sample a video into frames and build an MJPG-AVI for the badge. */
export async function videoToBadgeAnimation(
  file: File,
  opts: { targetFps?: number; maxFrames?: number; maxSeconds?: number; maxBytes?: number } = {},
): Promise<EncodedAnimation> {
  const frames = await videoToFrames(file, {
    targetFps: opts.targetFps,
    maxFrames: opts.maxFrames,
    maxSeconds: opts.maxSeconds,
  })
  // Uniform per-frame durations → fpsFromFrames recovers ≈targetFps (clamped),
  // matching framesToAvi's fixed-fps stream to the sampled cadence.
  const fps = fpsFromFrames(frames)
  return framesToAvi(frames, fps, opts.maxBytes)
}
