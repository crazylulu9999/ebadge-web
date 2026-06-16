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

/** Conservative upload budget. Well within sizes proven to work on hardware. */
export const TARGET_MAX_BYTES = 60000

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
