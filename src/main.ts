import { E87Client, type LogLevel } from './e87-client'
import {
  fileToBadgeJpeg,
  fileToBadgeAnimation,
  filesToBadgeAnimation,
  videoToBadgeAnimation,
  type EncodedImage,
  type EncodedAnimation,
} from './image'

// ── element refs ─────────────────────────────────────────────

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const connectBtn = $<HTMLButtonElement>('connectBtn')
const disconnectBtn = $<HTMLButtonElement>('disconnectBtn')
const uploadBtn = $<HTMLButtonElement>('uploadBtn')
const stopBtn = $<HTMLButtonElement>('stopBtn')
const fileInput = $<HTMLInputElement>('fileInput')
const preview = $<HTMLImageElement>('preview')
const imgMeta = $<HTMLParagraphElement>('imgMeta')
const dot = $<HTMLSpanElement>('dot')
const statusText = $<HTMLSpanElement>('statusText')
const prog = $<HTMLProgressElement>('prog')
const logEl = $<HTMLDivElement>('log')
const unsupported = $<HTMLDivElement>('unsupported')
const copyLogBtn = $<HTMLButtonElement>('copyLogBtn')
const clearLogBtn = $<HTMLButtonElement>('clearLogBtn')

// ── logging ──────────────────────────────────────────────────

function log(level: LogLevel, msg: string): void {
  const line = document.createElement('div')
  line.className = `log-${level}`
  const t = new Date().toLocaleTimeString([], { hour12: false })
  line.textContent = `${t}  ${level.toUpperCase().padEnd(4)} ${msg}`
  logEl.appendChild(line)
  logEl.scrollTop = logEl.scrollHeight
}

// ── state ────────────────────────────────────────────────────

const client = new E87Client(log)
client.onDisconnect = () => setConnected(false)

type Prepared =
  | { kind: 'image'; data: EncodedImage }
  | { kind: 'animation'; data: EncodedAnimation }
let prepared: Prepared | null = null
// Bumped on every new selection; an in-flight encode whose id is stale on resolve
// discards its result (revokes its URLs) instead of clobbering a newer selection.
let selectionGen = 0

function setConnected(on: boolean): void {
  dot.classList.toggle('on', on)
  statusText.textContent = on ? '연결됨: E87' : '미연결'
  connectBtn.disabled = on
  disconnectBtn.disabled = !on
  refreshUploadBtn()
}

function refreshUploadBtn(): void {
  uploadBtn.disabled = !(client.connected && prepared)
}

// ── preview (animated for GIF / video / slideshow) ───────────

let previewTimer: number | undefined

function stopPreview(): void {
  if (previewTimer !== undefined) {
    clearTimeout(previewTimer)
    previewTimer = undefined
  }
}

/** Cycle the <img> preview through the frame URLs at `fps` — shows exactly what
 *  the badge will display (cropped, 368×368, sampled fps, JPEG quality). */
function playPreview(frameUrls: string[], fps: number): void {
  stopPreview()
  if (frameUrls.length === 0) return
  if (frameUrls.length === 1) {
    preview.src = frameUrls[0]
    return
  }
  const delay = Math.max(1, Math.round(1000 / fps))
  let i = 0
  const tick = () => {
    preview.src = frameUrls[i]
    i = (i + 1) % frameUrls.length
    previewTimer = window.setTimeout(tick, delay)
  }
  tick()
}

/** Revoke every object URL a prepared selection owns. */
function revokePrepared(p: Prepared): void {
  if (p.kind === 'animation') {
    for (const u of p.data.frameUrls) URL.revokeObjectURL(u)
  } else {
    URL.revokeObjectURL(p.data.previewUrl)
  }
}

/** Stop any preview animation and release the current selection's object URLs. */
function clearPrepared(): void {
  stopPreview()
  if (prepared) revokePrepared(prepared)
  prepared = null
}

function showImage(img: EncodedImage): void {
  preview.src = img.previewUrl
  const kb = (img.jpeg.length / 1024).toFixed(1)
  const qPct = Math.round(img.quality * 100)
  imgMeta.innerHTML = `<b>368×368</b> JPEG · <b>${kb} KB</b> · 품질 ${qPct}%`
  log('info', `encoded: ${img.jpeg.length} bytes (quality ${qPct}%)`)
  if (img.overBudget) {
    log('warn', `이미지가 권장 용량(${Math.round(img.maxBytes / 1024)}KB)을 넘습니다 — 전송이 실패할 수 있어요.`)
  }
}

function showAnimation(anim: EncodedAnimation, label: string): void {
  playPreview(anim.frameUrls, anim.fps)
  const kb = (anim.sizeBytes / 1024).toFixed(1)
  const qPct = Math.round(anim.quality * 100)
  imgMeta.innerHTML = `<b>368×368</b> ${label} · <b>${anim.frameCount} 프레임</b> · ${anim.fps}fps · <b>${kb} KB</b> · 품질 ${qPct}%`
  log('info', `animation: ${anim.frameCount} frames @ ${anim.fps}fps, ${anim.sizeBytes} bytes (quality ${qPct}%)`)
  if (anim.overBudget) {
    log('warn', `애니메이션이 권장 용량(${Math.round(anim.maxBytes / 1024)}KB)을 넘습니다 — 프레임 수나 길이를 줄여보세요.`)
  }
}

// ── browser support ──────────────────────────────────────────

if (!navigator.bluetooth) {
  unsupported.classList.remove('hidden')
  connectBtn.disabled = true
}

// ── events ───────────────────────────────────────────────────

connectBtn.addEventListener('click', async () => {
  try {
    await client.connect()
    setConnected(true)
  } catch (e) {
    log('err', (e as Error).message)
  }
})

disconnectBtn.addEventListener('click', async () => {
  await client.disconnect()
  setConnected(false)
})

fileInput.addEventListener('change', async () => {
  const files = Array.from(fileInput.files ?? [])
  if (files.length === 0) return

  // Drop the previous selection (stop its preview loop, free all its object URLs)
  // and clear the visible preview so a failed / non-image pick leaves no stale UI.
  clearPrepared()
  const myGen = ++selectionGen // any earlier in-flight encode is now stale
  preview.removeAttribute('src')
  imgMeta.textContent = '인코딩 중…'
  refreshUploadBtn()

  // Detect GIF / video by MIME *or* extension — some browsers report a blank type.
  const looksGif = (f: File) => /gif/i.test(f.type) || /\.gif$/i.test(f.name)
  // .ogv = Ogg video; plain .ogg is conventionally audio, so rely on the video/ MIME test for it.
  const looksVideo = (f: File) => /^video\//i.test(f.type) || /\.(mp4|webm|ogv|mov|m4v)$/i.test(f.name)
  const isGif = files.length === 1 && looksGif(files[0])
  const isVideo = files.length === 1 && looksVideo(files[0])
  if (files.length > 1 && files.some(looksVideo)) {
    imgMeta.textContent = '동영상은 한 번에 한 개만 선택하세요.'
    log('warn', '동영상은 여러 파일과 함께 선택할 수 없습니다. 동영상 1개만 선택하세요.')
    return
  }
  if (files.length > 1 && files.some(looksGif)) {
    log('warn', 'GIF는 여러 장 선택 시 각 GIF의 첫 프레임만 슬라이드쇼로 사용됩니다. 애니메이션 재생은 GIF 1장만 선택하세요.')
  }

  // A newer selection started while this one was encoding: discard this result
  // (freeing its object URLs) instead of clobbering the newer selection's UI/state.
  const stale = (result: Prepared): boolean => {
    if (myGen === selectionGen) return false
    revokePrepared(result)
    return true
  }

  try {
    if (isGif) {
      log('info', `decoding GIF ${files[0].name}…`)
      const anim = await fileToBadgeAnimation(files[0])
      const result: Prepared = { kind: 'animation', data: anim }
      if (stale(result)) return
      prepared = result
      showAnimation(anim, 'GIF')
    } else if (isVideo) {
      log('info', `sampling video ${files[0].name}…`)
      const anim = await videoToBadgeAnimation(files[0])
      const result: Prepared = { kind: 'animation', data: anim }
      if (stale(result)) return
      prepared = result
      showAnimation(anim, '동영상')
    } else if (files.length > 1) {
      log('info', `building slideshow from ${files.length} images…`)
      const anim = await filesToBadgeAnimation(files)
      const result: Prepared = { kind: 'animation', data: anim }
      if (stale(result)) return
      prepared = result
      showAnimation(anim, '슬라이드쇼')
    } else {
      log('info', `encoding ${files[0].name}…`)
      const img = await fileToBadgeJpeg(files[0])
      const result: Prepared = { kind: 'image', data: img }
      if (stale(result)) return
      prepared = result
      showImage(img)
    }
    refreshUploadBtn()
  } catch (e) {
    if (myGen !== selectionGen) return // a newer selection owns the UI now
    imgMeta.textContent = '파일을 읽지 못했습니다.'
    log('err', (e as Error).message)
  }
})

uploadBtn.addEventListener('click', async () => {
  const p = prepared
  if (!p) return
  uploadBtn.disabled = true
  stopBtn.disabled = false
  prog.value = 0
  const onProgress = (sent: number, total: number) => {
    prog.value = total > 0 ? Math.round((sent / total) * 100) : 0
  }
  try {
    if (p.kind === 'image') {
      await client.uploadJpeg(p.data.jpeg, onProgress)
    } else {
      await client.uploadAnimation(p.data.aviBytes, onProgress)
    }
    prog.value = 100
  } catch (e) {
    const msg = (e as Error).message
    prog.value = 0
    if (msg === 'aborted') log('warn', 'transfer stopped')
    else log('err', msg)
  } finally {
    stopBtn.disabled = true
    refreshUploadBtn()
  }
})

stopBtn.addEventListener('click', () => {
  client.abort()
  log('warn', 'abort requested')
})

copyLogBtn.addEventListener('click', async () => {
  const text = logEl.innerText
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // fallback for non-secure contexts / older browsers
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
  }
  const original = copyLogBtn.textContent
  copyLogBtn.textContent = '복사됨 ✓'
  setTimeout(() => (copyLogBtn.textContent = original), 1200)
})

clearLogBtn.addEventListener('click', () => {
  logEl.replaceChildren()
})

log('info', 'ready — connect the badge (single-press its Bluetooth button first)')
