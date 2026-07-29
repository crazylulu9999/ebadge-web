import { E87Client, type LogLevel } from './e87-client'
import { uploadErrorText, encodeErrorText } from './errors'
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
const connNotice = $<HTMLDivElement>('connNotice')
const fileNotice = $<HTMLDivElement>('fileNotice')
const sendNotice = $<HTMLDivElement>('sendNotice')

// Captured at init, not at click time: reading textContent inside the handler
// re-captures the transient '✓' / '중지 중…' label when a second click lands
// inside the flash window, and the button then sticks on it forever.
const COPY_LABEL = copyLogBtn.textContent ?? '복사'
const STOP_LABEL = stopBtn.textContent ?? '중지'

// ── logging ──────────────────────────────────────────────────
// #log is an English protocol trace by design — it is what gets pasted into an
// issue and cross-referenced against the reference repos' protocol docs, so the
// lines we author here stay English and Korean user copy goes to the notice slots.
// The exception is deliberate: a raw `Error.message` is logged verbatim, and the
// encoders' messages are Korean. Keeping the original text is what makes a copied
// log complete evidence. Every notice also emits a log line; never the reverse.

function log(level: LogLevel, msg: string): void {
  // Measured BEFORE appending: only follow the tail if the user is already there,
  // otherwise reading scrollback gets yanked down on every BLE frame.
  const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 24
  const line = document.createElement('div')
  line.className = `log-${level}`
  const t = new Date().toLocaleTimeString([], { hour12: false })
  line.textContent = `${t}  ${level.toUpperCase().padEnd(4)} ${msg}`
  logEl.appendChild(line)
  if (atBottom) logEl.scrollTop = logEl.scrollHeight
}

// ── notices ──────────────────────────────────────────────────
// One banner slot per panel, owned by that panel's action. A slot holds exactly
// one message (last writer wins) — it is a status line, not a queue.

type NoticeKind = 'ok' | 'warn' | 'err'

/** Show `msg` in a banner slot.
 *  textContent, NEVER innerHTML — encode errors interpolate the user's file name
 *  (imagesToFrames in media-frames.ts), so `<img onerror=…>.png` would otherwise
 *  become stored XSS by file picker.
 *  Class first, then text: role="alert"/"status" only announces a mutation made
 *  while the region is rendered, so unhiding has to come first. */
function notice(slot: HTMLDivElement, kind: NoticeKind, msg: string): void {
  slot.className = `banner ${kind}`
  slot.textContent = msg
}

/** Hide a slot and drop its text so the live region cannot re-announce it. */
function clearNotice(slot: HTMLDivElement): void {
  slot.className = 'banner hidden'
  slot.textContent = ''
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

// Set by a completed upload, cleared once the user disconnects (the step that
// actually applies it) or picks new content. Drives the 연결 해제 highlight.
let pendingApply = false

function setPendingApply(on: boolean): void {
  pendingApply = on
  disconnectBtn.classList.toggle('attn', on)
}

function setConnected(on: boolean): void {
  dot.classList.toggle('on', on)
  statusText.textContent = on ? '연결됨: E87' : '미연결'
  connectBtn.disabled = on
  disconnectBtn.disabled = !on
  if (on) clearNotice(connNotice)
  // The disconnect the highlight was pointing at has happened.
  else setPendingApply(false)
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
    // The budget is a conservative guess, not a device-reported limit, and the
    // upload is attempted regardless — so say that rather than imply a failure.
    notice(
      fileNotice,
      'warn',
      `권장 용량(${Math.round(img.maxBytes / 1024)}KB)을 넘었습니다. 권장치는 보수적인 추정값이라 전송은 그대로 시도합니다.`,
    )
    log('warn', `over budget: ${img.jpeg.length}B > ${img.maxBytes}B (advisory)`)
  }
}

function showAnimation(anim: EncodedAnimation, label: string): void {
  playPreview(anim.frameUrls, anim.fps)
  const kb = (anim.sizeBytes / 1024).toFixed(1)
  const qPct = Math.round(anim.quality * 100)
  imgMeta.innerHTML = `<b>368×368</b> ${label} · <b>${anim.frameCount} 프레임</b> · ${anim.fps}fps · <b>${kb} KB</b> · 품질 ${qPct}%`
  log('info', `animation: ${anim.frameCount} frames @ ${anim.fps}fps, ${anim.sizeBytes} bytes (quality ${qPct}%)`)
  if (anim.overBudget) {
    // Was "프레임 수나 길이를 줄여보세요" — but no UI exposes frame count or
    // duration, so that instructed an impossible action. State the real situation.
    notice(
      fileNotice,
      'warn',
      `권장 용량(${Math.round(anim.maxBytes / 1024)}KB)을 넘었습니다. 권장치는 하드웨어로 확인되지 않은 보수적인 추정값이라 전송은 그대로 시도합니다.`,
    )
    log('warn', `over budget: ${anim.sizeBytes}B > ${anim.maxBytes}B (advisory)`)
  }
}

// ── browser support ──────────────────────────────────────────

if (!navigator.bluetooth) {
  unsupported.classList.remove('hidden')
  connectBtn.disabled = true
}

// ── events ───────────────────────────────────────────────────

connectBtn.addEventListener('click', async () => {
  clearNotice(connNotice)
  try {
    await client.connect()
    setConnected(true)
  } catch (e) {
    const err = e as Error
    log('err', `${err.name}: ${err.message}`)
    // Dismissing the browser's own device chooser is a deliberate action, not a
    // failure — don't answer it with an error banner. Chrome reports both "user
    // cancelled" and "no devices found" as NotFoundError, hence the message test.
    if (err.name === 'NotFoundError' && /cancel/i.test(err.message)) return
    notice(
      connNotice,
      'err',
      '배지에 연결하지 못했습니다. 배지의 블루투스 버튼을 한 번 눌러 페어링 모드로 만든 뒤 다시 시도해 주세요.',
    )
  }
})

disconnectBtn.addEventListener('click', async () => {
  // Read before awaiting: disconnect() fires onDisconnect, which clears the flag.
  const applying = pendingApply
  await client.disconnect()
  setConnected(false)
  if (applying) notice(sendNotice, 'ok', '연결을 해제했습니다 — 배지에 새 내용이 적용됩니다.')
  else clearNotice(sendNotice)
  log('info', 'disconnected')
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
  clearNotice(fileNotice)
  clearNotice(sendNotice) // a stale "전송 완료" beside fresh content is a lie
  setPendingApply(false)
  refreshUploadBtn()

  // Detect GIF / video by MIME *or* extension — some browsers report a blank type.
  const looksGif = (f: File) => /gif/i.test(f.type) || /\.gif$/i.test(f.name)
  // .ogv = Ogg video; plain .ogg is conventionally audio, so rely on the video/ MIME test for it.
  const looksVideo = (f: File) => /^video\//i.test(f.type) || /\.(mp4|webm|ogv|mov|m4v)$/i.test(f.name)
  const isGif = files.length === 1 && looksGif(files[0])
  const isVideo = files.length === 1 && looksVideo(files[0])
  if (files.length > 1 && files.some(looksVideo)) {
    imgMeta.textContent = ''
    notice(fileNotice, 'warn', '동영상은 한 번에 한 개만 선택할 수 있습니다. 다른 파일과 함께 고를 수 없어요.')
    log('warn', 'rejected: video cannot be combined with other files')
    return
  }
  if (files.length > 1 && files.some(looksGif)) {
    notice(
      fileNotice,
      'warn',
      'GIF를 여러 장과 함께 고르면 각 GIF의 첫 프레임만 슬라이드쇼로 쓰입니다. 애니메이션으로 만들려면 GIF 1장만 선택하세요.',
    )
    log('warn', 'multi-select with GIF: first frame of each GIF only')
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
    const msg = (e as Error).message
    imgMeta.textContent = ''
    // image.ts / media-frames.ts throw Korean, user-actionable copy (missing
    // WebCodecs, unsupported codec, no frames extracted). Show it verbatim —
    // replacing it with a generic line and hiding the real cause in the debug
    // log is pure loss.
    notice(fileNotice, 'err', encodeErrorText(msg))
    log('err', msg)
  }
})

uploadBtn.addEventListener('click', async () => {
  const p = prepared
  if (!p) return
  uploadBtn.disabled = true
  stopBtn.disabled = false
  stopBtn.textContent = STOP_LABEL
  clearNotice(sendNotice)
  setPendingApply(false)
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
    // THE thing users get wrong: by spec the badge holds new content until the
    // BLE link drops. Without this the badge looks unchanged after a successful
    // upload, and a working transfer reads as a failure.
    notice(sendNotice, 'ok', '전송 완료 — "연결 해제"를 눌러야 배지에 적용됩니다.')
    setPendingApply(true)
    log('info', 'upload complete — badge applies content on disconnect')
  } catch (e) {
    const msg = (e as Error).message
    prog.value = 0
    if (msg === 'aborted') {
      notice(sendNotice, 'warn', '전송을 중지했습니다.')
      log('warn', 'transfer stopped')
    } else {
      notice(sendNotice, 'err', uploadErrorText(msg))
      log('err', msg)
    }
  } finally {
    stopBtn.disabled = true
    stopBtn.textContent = STOP_LABEL
    refreshUploadBtn()
  }
})

stopBtn.addEventListener('click', () => {
  client.abort()
  // abort() only sets a flag polled at window/loop boundaries, so acknowledge the
  // click now instead of leaving a live button that looks inert for a second.
  stopBtn.disabled = true
  stopBtn.textContent = '중지 중…'
  log('warn', 'abort requested')
})

let copyFlashTimer: number | undefined

/** Transient confirmation on the button itself (1.2s, '✓'). Restarting the timer
 *  keeps rapid clicks from fighting each other, and COPY_LABEL is captured at
 *  init so the restore target can never become the transient text. */
function flashCopy(text: string): void {
  copyLogBtn.textContent = text
  if (copyFlashTimer !== undefined) clearTimeout(copyFlashTimer)
  copyFlashTimer = window.setTimeout(() => {
    copyLogBtn.textContent = COPY_LABEL
    copyFlashTimer = undefined
  }, 1200)
}

copyLogBtn.addEventListener('click', async () => {
  const text = logEl.innerText
  let ok = true
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
    ok = document.execCommand('copy')
    ta.remove()
  }
  flashCopy(ok ? '복사됨 ✓' : '복사 실패')
})

clearLogBtn.addEventListener('click', () => {
  logEl.replaceChildren()
})

// The Bluetooth-button precondition this line used to carry now lives in the UI
// as a standing hint beside the connect button, where it is actually read.
log('info', 'ready')
