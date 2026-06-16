import { E87Client, type LogLevel } from './e87-client'
import {
  fileToBadgeJpeg,
  fileToBadgeAnimation,
  filesToBadgeAnimation,
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
  preview.src = anim.previewUrl
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

  // Drop the previous selection (free its preview URL) and clear the visible
  // preview so a failed / non-image pick can't leave stale UI behind.
  if (prepared) URL.revokeObjectURL(prepared.data.previewUrl)
  prepared = null
  preview.removeAttribute('src')
  imgMeta.textContent = '인코딩 중…'
  refreshUploadBtn()

  // Detect GIF by MIME *or* extension — some browsers report a blank type for .gif.
  const looksGif = (f: File) => /gif/i.test(f.type) || /\.gif$/i.test(f.name)
  const isGif = files.length === 1 && looksGif(files[0])
  if (files.length > 1 && files.some(looksGif)) {
    log('warn', 'GIF는 여러 장 선택 시 각 GIF의 첫 프레임만 슬라이드쇼로 사용됩니다. 애니메이션 재생은 GIF 1장만 선택하세요.')
  }

  try {
    if (isGif) {
      log('info', `decoding GIF ${files[0].name}…`)
      const anim = await fileToBadgeAnimation(files[0])
      prepared = { kind: 'animation', data: anim }
      showAnimation(anim, 'GIF')
    } else if (files.length > 1) {
      log('info', `building slideshow from ${files.length} images…`)
      const anim = await filesToBadgeAnimation(files)
      prepared = { kind: 'animation', data: anim }
      showAnimation(anim, '슬라이드쇼')
    } else {
      log('info', `encoding ${files[0].name}…`)
      const img = await fileToBadgeJpeg(files[0])
      prepared = { kind: 'image', data: img }
      showImage(img)
    }
    refreshUploadBtn()
  } catch (e) {
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
