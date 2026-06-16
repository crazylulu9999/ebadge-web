import { E87Client, type LogLevel } from './e87-client'
import { fileToBadgeJpeg, type EncodedImage } from './image'

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
let encoded: EncodedImage | null = null

function setConnected(on: boolean): void {
  dot.classList.toggle('on', on)
  statusText.textContent = on ? '연결됨: E87' : '미연결'
  connectBtn.disabled = on
  disconnectBtn.disabled = !on
  refreshUploadBtn()
}

function refreshUploadBtn(): void {
  uploadBtn.disabled = !(client.connected && encoded)
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
  const file = fileInput.files?.[0]
  if (!file) return
  try {
    log('info', `encoding ${file.name}…`)
    encoded = await fileToBadgeJpeg(file)
    preview.src = encoded.previewUrl
    const kb = (encoded.jpeg.length / 1024).toFixed(1)
    const qPct = Math.round(encoded.quality * 100)
    imgMeta.innerHTML = `<b>368×368</b> JPEG · <b>${kb} KB</b> · 품질 ${qPct}%`
    log('info', `encoded: ${encoded.jpeg.length} bytes (quality ${qPct}%)`)
    if (encoded.overBudget) {
      log('warn', `이미지가 권장 용량(${Math.round(encoded.maxBytes / 1024)}KB)을 넘습니다 — 전송이 실패할 수 있어요.`)
    }
    refreshUploadBtn()
  } catch (e) {
    log('err', (e as Error).message)
  }
})

uploadBtn.addEventListener('click', async () => {
  if (!encoded) return
  uploadBtn.disabled = true
  stopBtn.disabled = false
  prog.value = 0
  try {
    await client.uploadJpeg(encoded.jpeg, (sent, total) => {
      prog.value = Math.round((sent / total) * 100)
    })
    prog.value = 100
  } catch (e) {
    log('err', (e as Error).message)
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
