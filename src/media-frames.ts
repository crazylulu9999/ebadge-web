/**
 * Decode media into ordered, drawable frames for the 368×368 E87 badge.
 *
 * These functions do NOT JPEG-encode — they return drawable 368×368 canvases
 * plus per-frame durations. The caller (`src/image.ts`) JPEG-encodes each
 * canvas with the existing encoder and feeds the bytes to `buildMjpgAvi`.
 *
 * GIF decoding uses the WebCodecs `ImageDecoder` API (Chrome / Edge). It is not
 * available in Firefox/Safari; callers get a clear error there.
 */

import { E87_IMAGE_SIZE } from './e87-client'

// ── Minimal WebCodecs typings ────────────────────────────────
// We reach `ImageDecoder` through `globalThis` rather than `declare const` so
// this never clashes with whatever WebCodecs types the active TypeScript DOM
// lib does (or doesn't) ship. The WC* interfaces are local-only.

interface WCVideoFrame {
  /** Presentation duration in MICROSECONDS (may be null for static images). */
  readonly duration: number | null
  readonly displayWidth: number
  readonly displayHeight: number
  close(): void
}
interface WCImageDecodeResult {
  readonly image: WCVideoFrame
  readonly complete: boolean
}
interface WCImageTrack {
  readonly frameCount: number
  readonly animated: boolean
}
interface WCImageTrackList {
  readonly ready: Promise<void>
  readonly selectedTrack: WCImageTrack | null
}
interface WCImageDecoder {
  readonly tracks: WCImageTrackList
  readonly completed: Promise<void>
  decode(options?: { frameIndex?: number }): Promise<WCImageDecodeResult>
  close(): void
}
interface WCImageDecoderCtor {
  new (init: { data: BufferSource; type: string }): WCImageDecoder
  isTypeSupported(type: string): Promise<boolean>
}

const ImageDecoderCtor = (globalThis as { ImageDecoder?: WCImageDecoderCtor }).ImageDecoder

/** True if this browser can decode animated images via WebCodecs. */
export function canDecodeAnimation(): boolean {
  return typeof ImageDecoderCtor !== 'undefined'
}

// ── Frame container ──────────────────────────────────────────

export interface BadgeFrame {
  /** Already center-cropped/scaled to E87_IMAGE_SIZE × E87_IMAGE_SIZE. */
  canvas: HTMLCanvasElement
  /** Per-frame display duration in milliseconds. */
  durationMs: number
}

/** Per-frame duration (ms) assumed when a GIF frame reports none. */
const DEFAULT_FRAME_MS = 100
/** Hard ceiling so a pathological GIF cannot exhaust memory. */
const ABSOLUTE_MAX_FRAMES = 600

// ── Canvas helpers ───────────────────────────────────────────

function makeBadgeCanvas(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas')
  canvas.width = E87_IMAGE_SIZE
  canvas.height = E87_IMAGE_SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 2D 컨텍스트를 만들 수 없습니다.')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  return { canvas, ctx }
}

/**
 * Draw a source center-cropped to a square and scaled to fill 368×368 — the
 * same geometry as `fileToBadgeJpeg` in image.ts.
 */
function drawCenterCropped(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
): void {
  const side = Math.min(srcW, srcH)
  const sx = (srcW - side) / 2
  const sy = (srcH - side) / 2
  ctx.clearRect(0, 0, E87_IMAGE_SIZE, E87_IMAGE_SIZE)
  ctx.drawImage(source, sx, sy, side, side, 0, 0, E87_IMAGE_SIZE, E87_IMAGE_SIZE)
}

// ── GIF → frames (WebCodecs) ─────────────────────────────────

/**
 * Decode an animated (or static) GIF into ordered 368×368 frames with per-frame
 * durations.
 *
 * @param file       the GIF File (file.type should be 'image/gif')
 * @param opts.maxFrames  cap on frames decoded (default 300)
 */
export async function gifToFrames(file: File, opts?: { maxFrames?: number }): Promise<BadgeFrame[]> {
  const type = file.type || 'image/gif'
  if (!ImageDecoderCtor) {
    throw new Error(
      'GIF 디코딩에는 WebCodecs(ImageDecoder)가 필요합니다. Chrome/Edge에서 열어주세요.',
    )
  }
  if (!(await ImageDecoderCtor.isTypeSupported(type))) {
    throw new Error(`이 브라우저는 ${type} 디코딩을 지원하지 않습니다.`)
  }

  const cap = Math.max(1, Math.min(opts?.maxFrames ?? 300, ABSOLUTE_MAX_FRAMES))

  // Buffer the whole file: this makes frameCount final and lets us decode by
  // index deterministically (streaming can leave frameCount incomplete).
  const data = await file.arrayBuffer()
  const decoder = new ImageDecoderCtor({ data, type })

  const frames: BadgeFrame[] = []
  try {
    await decoder.tracks.ready
    const track = decoder.tracks.selectedTrack
    if (!track) throw new Error('GIF 트랙을 찾을 수 없습니다.')

    // `completed` guarantees the final frameCount now that all data is buffered.
    await decoder.completed

    const total = Math.max(1, track.frameCount) // static GIF reports 1
    const count = Math.min(total, cap)

    for (let i = 0; i < count; i++) {
      const { image } = await decoder.decode({ frameIndex: i })
      try {
        const { canvas, ctx } = makeBadgeCanvas()
        drawCenterCropped(ctx, image as unknown as CanvasImageSource, image.displayWidth, image.displayHeight)
        // VideoFrame.duration is in microseconds; convert to ms.
        const durUs = image.duration
        const durationMs = durUs != null && durUs > 0 ? Math.round(durUs / 1000) : DEFAULT_FRAME_MS
        frames.push({ canvas, durationMs })
      } finally {
        image.close() // release decoder/GPU memory promptly
      }
    }
  } finally {
    decoder.close()
  }

  if (frames.length === 0) throw new Error('GIF에서 프레임을 추출하지 못했습니다.')
  return frames
}

// ── Stills → slideshow frames ────────────────────────────────

/**
 * Build a slideshow from multiple still images. Each is decoded, center-cropped
 * to 368×368, and given a uniform per-frame duration.
 *
 * @param files    still images (jpeg/png/webp/…)
 * @param frameMs  uniform display duration per frame in milliseconds (>0)
 */
export async function imagesToFrames(
  files: File[],
  frameMs: number,
  opts?: { maxFrames?: number },
): Promise<BadgeFrame[]> {
  if (files.length === 0) throw new Error('이미지를 선택하세요.')
  const durationMs = frameMs > 0 ? Math.round(frameMs) : DEFAULT_FRAME_MS
  // Mirror gifToFrames' ceiling so a huge multi-select can't exhaust memory.
  const cap = Math.max(1, Math.min(opts?.maxFrames ?? 300, ABSOLUTE_MAX_FRAMES))

  const frames: BadgeFrame[] = []
  for (const file of files.slice(0, cap)) {
    let bitmap: ImageBitmap
    try {
      bitmap = await createImageBitmap(file)
    } catch {
      throw new Error(`이미지를 읽을 수 없습니다: ${file.name} (지원하지 않는 형식일 수 있어요).`)
    }
    try {
      const { canvas, ctx } = makeBadgeCanvas()
      drawCenterCropped(ctx, bitmap, bitmap.width, bitmap.height)
      frames.push({ canvas, durationMs })
    } finally {
      bitmap.close()
    }
  }
  return frames
}

// ── fps reconciliation ───────────────────────────────────────

/**
 * Reconcile variable GIF frame durations into a single AVI frame rate.
 *
 * AVI MJPG is fixed-fps (every frame plays for `dwMicroSecPerFrame`), so we
 * derive fps from the AVERAGE per-frame duration and clamp it to [min,max] so
 * neither a 10ms-burst nor a 5s-per-frame GIF produces a degenerate stream.
 */
export function fpsFromFrames(frames: BadgeFrame[], min = 1, max = 30): number {
  if (frames.length === 0) return min
  const totalMs = frames.reduce((s, f) => s + (f.durationMs > 0 ? f.durationMs : DEFAULT_FRAME_MS), 0)
  const avgMs = totalMs / frames.length
  const fps = avgMs > 0 ? 1000 / avgMs : max
  return Math.max(min, Math.min(max, Math.round(fps)))
}
