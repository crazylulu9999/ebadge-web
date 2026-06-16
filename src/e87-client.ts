/**
 * E87 / L8 JieLi badge BLE client (Web Bluetooth).
 *
 * Protocol reverse-engineered by hybridherbst/web-bluetooth-e87 and
 * jumpingmushroom/e87_badge (both MIT). TypeScript port of the image-upload path:
 *
 *   connect → subscribe → mutual auth → control handshake → offset-driven
 *   windowed JPEG transfer → completion handshake.
 *
 * Works on Chrome / Edge (desktop + Android). Not supported on iOS.
 */

import { getRandomAuthData, getEncryptedAuthData } from './jl-auth'
import { crc16xmodem } from './crc16'

// ── UUIDs ───────────────────────────────────────────────────

const SVC_AE = 0xae00 // 0000ae00-0000-1000-8000-00805f9b34fb
const ae = (n: number) => `0000ae0${n}-0000-1000-8000-00805f9b34fb`
const FD_SVC = 'c2e6fd00-e966-1000-8000-bef9c223df6a'
const fd = (n: number) => `c2e6fd0${n}-e966-1000-8000-bef9c223df6a`

// ── Protocol constants ──────────────────────────────────────

export const E87_IMAGE_SIZE = 368
const DATA_CHUNK = 490
const MAGIC = [0xfe, 0xdc, 0xba]
const TRAILER = 0xef

const FLAG_REQ = 0xc0
const FLAG_RESP = 0x00
const FLAG_DATA = 0x80

const CMD_RESET_AUTH = 0x06
const CMD_DEV_INFO = 0x03
const CMD_SYS_INFO = 0x07
const CMD_BEGIN = 0x21
const CMD_PARAMS = 0x27
const CMD_FILE_META = 0x1b
const CMD_DATA = 0x01
const CMD_WINDOW_ACK = 0x1d
const CMD_COMPLETE = 0x20
const CMD_FINALIZE = 0x1c

export type LogLevel = 'info' | 'tx' | 'rx' | 'warn' | 'err'
export type Logger = (level: LogLevel, msg: string) => void
export type Progress = (sent: number, total: number) => void
/** Still image (.jpg) or animation (.avi). Only the completion ext differs. */
export type UploadMode = 'image' | 'animation'

// ── Frame helpers ───────────────────────────────────────────

interface Frame {
  flag: number
  cmd: number
  body: Uint8Array
  raw: Uint8Array
}

function buildFrame(flag: number, cmd: number, body: Uint8Array): Uint8Array {
  const len = body.length
  const out = new Uint8Array(3 + 1 + 1 + 2 + len + 1)
  out.set(MAGIC, 0)
  out[3] = flag
  out[4] = cmd
  out[5] = (len >> 8) & 0xff
  out[6] = len & 0xff
  out.set(body, 7)
  out[7 + len] = TRAILER
  return out
}

function parseFrame(data: Uint8Array): Frame | null {
  if (data.length < 8) return null
  if (data[0] !== 0xfe || data[1] !== 0xdc || data[2] !== 0xba) return null
  const flag = data[3]
  const cmd = data[4]
  const len = (data[5] << 8) | data[6]
  const body = data.subarray(7, 7 + len)
  return { flag, cmd, body, raw: data }
}

function hex(data: Uint8Array, max = 32): string {
  const n = Math.min(data.length, max)
  let s = ''
  for (let i = 0; i < n; i++) s += data[i].toString(16).padStart(2, '0') + ' '
  if (data.length > max) s += `… (+${data.length - max})`
  return s.trim()
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// ── Connection / client ─────────────────────────────────────

export interface E87Connection {
  device: BluetoothDevice
  ae01: BluetoothRemoteGATTCharacteristic
  ae02: BluetoothRemoteGATTCharacteristic
  fd01?: BluetoothRemoteGATTCharacteristic
  fd02?: BluetoothRemoteGATTCharacteristic
  fd03?: BluetoothRemoteGATTCharacteristic
  fd05?: BluetoothRemoteGATTCharacteristic
}

interface Waiter {
  pred: (d: Uint8Array) => boolean
  resolve: (d: Uint8Array) => void
  reject: (e: Error) => void
  timer: number
}

export class E87Client {
  /** Called whenever the GATT link drops (so the UI can reset its state). */
  onDisconnect?: () => void

  private conn: E87Connection | null = null
  private ae02Buf: Uint8Array[] = []
  private ae02Waiters: Waiter[] = []
  private fdLast = new Map<string, Uint8Array>()
  private seq = 0
  private aborted = false
  private autoRespond20 = false
  private fileCompleteHandled = false
  private authenticated = false
  private uploadMode: UploadMode = 'image'

  constructor(private log: Logger = () => {}) {}

  get connected(): boolean {
    return !!this.conn?.device.gatt?.connected
  }

  // ── connect / disconnect ─────────────────────────────────

  async connect(): Promise<void> {
    if (!navigator.bluetooth) throw new Error('Web Bluetooth not supported in this browser')

    this.authenticated = false
    this.log('info', 'requesting device…')
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [SVC_AE] }, { namePrefix: 'E87' }],
      optionalServices: [SVC_AE, FD_SVC, 'battery_service'],
    })
    this.log('info', `selected ${device.name ?? '(unnamed)'}`)

    device.addEventListener('gattserverdisconnected', () => {
      this.log('warn', 'GATT disconnected')
      this.conn = null
      this.authenticated = false
      this.onDisconnect?.()
    })

    const server = await device.gatt!.connect()
    this.log('info', 'GATT connected, discovering services…')

    const aeSvc = await server.getPrimaryService(SVC_AE)
    const ae01 = await aeSvc.getCharacteristic(ae(1))
    const ae02 = await aeSvc.getCharacteristic(ae(2))

    const conn: E87Connection = { device, ae01, ae02 }

    try {
      const fdSvc = await server.getPrimaryService(FD_SVC)
      conn.fd01 = await fdSvc.getCharacteristic(fd(1)).catch(() => undefined)
      conn.fd02 = await fdSvc.getCharacteristic(fd(2)).catch(() => undefined)
      conn.fd03 = await fdSvc.getCharacteristic(fd(3)).catch(() => undefined)
      conn.fd05 = await fdSvc.getCharacteristic(fd(5)).catch(() => undefined)
    } catch {
      this.log('warn', 'FD service not found (control sideband unavailable)')
    }

    // subscribe to notifications
    await ae02.startNotifications()
    ae02.addEventListener('characteristicvaluechanged', (e) => this.onAe02(e))
    await this.subscribeFd(conn.fd01, 'fd01')
    await this.subscribeFd(conn.fd03, 'fd03')
    await this.subscribeFd(conn.fd05, 'fd05')

    this.conn = conn
    this.log('info', 'subscribed; ready')
  }

  async disconnect(): Promise<void> {
    this.aborted = true
    this.authenticated = false
    try {
      this.conn?.device.gatt?.disconnect()
    } catch {
      /* ignore */
    }
    this.conn = null
  }

  abort(): void {
    this.aborted = true
  }

  private async subscribeFd(
    ch: BluetoothRemoteGATTCharacteristic | undefined,
    name: string,
  ): Promise<void> {
    if (!ch) return
    try {
      await ch.startNotifications()
      ch.addEventListener('characteristicvaluechanged', (e) => {
        const v = new Uint8Array((e.target as BluetoothRemoteGATTCharacteristic).value!.buffer)
        this.fdLast.set(name, v)
      })
    } catch {
      this.log('warn', `could not subscribe ${name}`)
    }
  }

  // ── notification plumbing ────────────────────────────────

  private onAe02(e: Event): void {
    const v = new Uint8Array((e.target as BluetoothRemoteGATTCharacteristic).value!.buffer)
    const f = parseFrame(v)
    if (f) this.log('rx', `frame cmd=0x${f.cmd.toString(16)} flag=0x${f.flag.toString(16)} ${hex(f.body, 16)}`)
    else this.log('rx', `raw ${hex(v, 20)}`)

    // Fast-path auto-respond to FILE_COMPLETE (badge has a ~100ms timeout here).
    if (this.autoRespond20 && !this.fileCompleteHandled && f && f.cmd === CMD_COMPLETE && f.flag === FLAG_REQ) {
      this.fileCompleteHandled = true
      const devSeq = f.body[0] ?? 0
      this.log('tx', 'auto-respond cmd 0x20 (file path)')
      this.writeAe01(buildFrame(FLAG_RESP, CMD_COMPLETE, this.buildFilePathResponse(devSeq))).catch(() => {})
    }

    // try to satisfy a waiter; otherwise buffer
    for (let i = 0; i < this.ae02Waiters.length; i++) {
      const w = this.ae02Waiters[i]
      if (w.pred(v)) {
        clearTimeout(w.timer)
        this.ae02Waiters.splice(i, 1)
        w.resolve(v)
        return
      }
    }
    this.ae02Buf.push(v)
  }

  private waitAe02(pred: (d: Uint8Array) => boolean, timeoutMs: number): Promise<Uint8Array> {
    for (let i = 0; i < this.ae02Buf.length; i++) {
      if (pred(this.ae02Buf[i])) {
        const [d] = this.ae02Buf.splice(i, 1)
        return Promise.resolve(d)
      }
    }
    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        const idx = this.ae02Waiters.findIndex((w) => w.timer === timer)
        if (idx >= 0) this.ae02Waiters.splice(idx, 1)
        reject(new Error('timeout waiting for badge response'))
      }, timeoutMs)
      this.ae02Waiters.push({ pred, resolve, reject, timer })
    })
  }

  private async waitFrame(cmd: number, flag: number, timeoutMs: number): Promise<Frame> {
    const raw = await this.waitAe02((d) => {
      const f = parseFrame(d)
      return !!f && f.cmd === cmd && f.flag === flag
    }, timeoutMs)
    return parseFrame(raw)!
  }

  private async waitFrameAny(cmds: number[], timeoutMs: number): Promise<Frame> {
    const raw = await this.waitAe02((d) => {
      const f = parseFrame(d)
      return !!f && cmds.includes(f.cmd)
    }, timeoutMs)
    return parseFrame(raw)!
  }

  // ── low-level writes ─────────────────────────────────────

  private async writeAe01(data: Uint8Array): Promise<void> {
    await this.conn!.ae01.writeValueWithoutResponse(data as BufferSource)
  }

  private async sendFrame(flag: number, cmd: number, body: Uint8Array): Promise<void> {
    const f = buildFrame(flag, cmd, body)
    this.log('tx', `frame cmd=0x${cmd.toString(16)} flag=0x${flag.toString(16)} ${hex(body, 16)}`)
    await this.writeAe01(f)
  }

  private async writeFd02(data: Uint8Array): Promise<void> {
    if (!this.conn?.fd02) return
    this.log('tx', `fd02 ${hex(data, 16)}`)
    try {
      await this.conn.fd02.writeValueWithoutResponse(data as BufferSource)
    } catch {
      try {
        await this.conn.fd02.writeValue(data as BufferSource)
      } catch {
        /* best effort */
      }
    }
  }

  // ── auth handshake ───────────────────────────────────────

  private async authenticate(): Promise<void> {
    this.log('info', 'auth: sending challenge')
    await this.writeAe01(getRandomAuthData())
    await this.waitAe02((d) => d.length >= 1 && d[0] === 0x01, 5000).catch(() => {
      this.log('warn', 'auth: no device response to challenge (continuing)')
    })
    await this.writeAe01(Uint8Array.of(0x02, 0x70, 0x61, 0x73, 0x73))
    const challenge = await this.waitAe02((d) => d.length >= 17 && d[0] === 0x00, 5000)
    await this.writeAe01(getEncryptedAuthData(challenge))
    await this.waitAe02((d) => d.length >= 1 && d[0] === 0x02, 5000).catch(() => {
      this.log('warn', 'auth: no final "pass" (continuing optimistically)')
    })
    this.log('info', 'auth: complete')
  }

  // ── control handshake (phases 1–7) ───────────────────────

  private async controlHandshake(): Promise<void> {
    await this.sendFrame(FLAG_REQ, CMD_RESET_AUTH, Uint8Array.of(0x02, 0x00, 0x01))
    this.seq = 0x01
    await sleep(120)

    await this.writeFd02(this.buildTimeFd02())
    await this.writeFd02(Uint8Array.of(0x9e, 0x20, 0x08, 0x16, 0x01, 0x00, 0x01))
    await this.writeFd02(Uint8Array.of(0x9e, 0xb5, 0x0b, 0x29, 0x01, 0x00, 0x80))
    await sleep(120)

    await this.sendFrame(FLAG_REQ, CMD_DEV_INFO, Uint8Array.of(this.seq, 0xff, 0xff, 0xff, 0xff, 0x01))
    this.seq++
    await this.waitFrame(CMD_DEV_INFO, FLAG_RESP, 2500).catch(() => this.log('warn', 'no dev-info ack'))

    await this.sendFrame(FLAG_REQ, CMD_SYS_INFO, Uint8Array.of(this.seq, 0xff, 0xff, 0xff, 0xff, 0xff))
    this.seq++
    await this.waitFrame(CMD_SYS_INFO, FLAG_RESP, 2500).catch(() => this.log('warn', 'no sys-info ack'))

    await this.writeFd02(Uint8Array.of(0x9e, 0xb5, 0x0b, 0x29, 0x01, 0x00, 0x80))
    await sleep(400)
    await this.writeFd02(Uint8Array.of(0x9e, 0xd3, 0x0b, 0xc6, 0x01, 0x00, 0x01))
    await sleep(300)
    await this.writeFd02(Uint8Array.of(0x9e, 0xf4, 0x0b, 0xdc, 0x01, 0x00, 0x0c))
    await sleep(300)

    await this.sendFrame(FLAG_REQ, CMD_BEGIN, Uint8Array.of(this.seq, 0x00))
    this.seq++
    await this.waitFrame(CMD_BEGIN, FLAG_RESP, 4000)

    await this.sendFrame(FLAG_REQ, CMD_PARAMS, Uint8Array.of(this.seq, 0x00, 0x00, 0x00, 0x00, 0x02, 0x01))
    this.seq++
    await this.waitFrame(CMD_PARAMS, FLAG_RESP, 4000)
  }

  private buildTimeFd02(): Uint8Array {
    const now = new Date()
    const y = now.getFullYear()
    return Uint8Array.of(
      0x9e, 0x45, 0x08, 0x02, 0x07, 0x00,
      (y >> 8) & 0xff, y & 0xff,
      now.getMonth() + 1, now.getDate(), 0x00,
      now.getHours(), now.getMinutes(),
    )
  }

  // ── upload ───────────────────────────────────────────────

  /** Upload a still JPEG (already encoded, 368×368). Thin wrapper over uploadFile. */
  async uploadJpeg(jpeg: Uint8Array, onProgress: Progress = () => {}): Promise<void> {
    return this.uploadFile(jpeg, { mode: 'image' }, onProgress)
  }

  /** Upload an MJPG-AVI animation (built by buildMjpgAvi). */
  async uploadAnimation(avi: Uint8Array, onProgress: Progress = () => {}): Promise<void> {
    return this.uploadFile(avi, { mode: 'animation' }, onProgress)
  }

  /**
   * Upload a complete file to the badge. Still JPEG and MJPG-AVI animation use
   * the EXACT same transfer path; the only difference is the completion
   * path-response extension (.jpg vs .avi), driven by this.uploadMode.
   */
  async uploadFile(
    bytes: Uint8Array,
    opts: { mode?: UploadMode } = {},
    onProgress: Progress = () => {},
  ): Promise<void> {
    this.uploadMode = opts.mode ?? 'image'
    if (!this.connected) throw new Error('not connected')
    this.aborted = false
    this.ae02Buf = []
    this.fileCompleteHandled = false
    this.autoRespond20 = false

    // Auth is a once-per-connection handshake; the badge ignores a repeat.
    // Subsequent uploads reuse the session and start at the control handshake
    // (cmd 0x06 resets the transfer state).
    if (!this.authenticated) {
      await this.authenticate()
      this.authenticated = true
    } else {
      this.log('info', 'reusing authenticated session')
    }
    await this.controlHandshake()

    // Phase 8 — file metadata
    const fileCrc = crc16xmodem(bytes)
    const name = this.tempName()
    await this.sendFrame(FLAG_REQ, CMD_FILE_META, this.buildMetaBody(bytes.length, fileCrc, name))
    this.seq++
    const metaAck = await this.waitFrame(CMD_FILE_META, FLAG_RESP, 5000)

    let chunkSize = DATA_CHUNK
    if (metaAck.body.length >= 4) {
      const cs = (metaAck.body[2] << 8) | metaAck.body[3]
      if (cs > 0 && cs <= 4096) chunkSize = cs
    }
    this.log('info', `metadata acked — size=${bytes.length}B crc=0x${fileCrc.toString(16)} chunk=${chunkSize} name=${name}`)

    // Phase 9 — offset-driven windowed transfer.
    // The badge dictates the next byte offset + window size in each 0x1d ack.
    // The loop ONLY ends on 0x20 (complete) or 0x1c (close) — never on
    // "all bytes sent". The badge re-requests offset 0 (commit chunk) last.
    this.autoRespond20 = true
    let best = 0
    const reportProgress = (reached: number) => {
      if (reached > best) {
        best = reached
        onProgress(best, bytes.length)
      }
    }

    let currentAck: Frame = await this.waitFrame(CMD_WINDOW_ACK, FLAG_DATA, 10000)
    let done = false

    while (!done) {
      if (this.aborted) throw new Error('aborted')

      if (currentAck.cmd === CMD_WINDOW_ACK && currentAck.body.length >= 8) {
        const b = currentAck.body
        const winSize = (b[2] << 8) | b[3]
        const nextOffset = ((b[4] << 24) | (b[5] << 16) | (b[6] << 8) | b[7]) >>> 0
        await this.sendChunksAt(bytes, nextOffset, winSize, chunkSize, reportProgress)
        if (nextOffset === 0) this.log('info', 'commit chunk sent')
      }

      const frame = await this.waitFrameAny([CMD_WINDOW_ACK, CMD_COMPLETE, CMD_FINALIZE], 15000)

      if (frame.cmd === CMD_COMPLETE && frame.flag === FLAG_REQ) {
        if (!this.fileCompleteHandled) {
          await this.sendFrame(FLAG_RESP, CMD_COMPLETE, this.buildFilePathResponse(frame.body[0] ?? 0))
          this.fileCompleteHandled = true
        }
        const close = await this.waitFrame(CMD_FINALIZE, FLAG_REQ, 15000).catch(() => null)
        const finSeq = close?.body[0] ?? 0
        await this.sendFrame(FLAG_RESP, CMD_FINALIZE, Uint8Array.of(0x00, finSeq))
        done = true
        break
      }

      if (frame.cmd === CMD_FINALIZE) {
        await this.sendFrame(FLAG_RESP, CMD_FINALIZE, Uint8Array.of(0x00, frame.body[0] ?? 0))
        done = true
        break
      }

      currentAck = frame
    }

    this.autoRespond20 = false
    onProgress(bytes.length, bytes.length)
    this.log('info', '✅ upload complete')

    // Connection is kept open so multiple files can be sent in a row. The
    // badge stays on its Bluetooth screen until you disconnect manually; the
    // uploaded content is applied once the link drops.
  }

  private async sendChunksAt(
    data: Uint8Array,
    offset: number,
    winSize: number,
    chunkSize: number,
    onReached: (reached: number) => void,
  ): Promise<void> {
    let slot = 0
    let bytesSent = 0
    let chunks = 0
    while (bytesSent < winSize) {
      if (this.aborted) throw new Error('aborted')
      const chunkOffset = offset + bytesSent
      if (chunkOffset >= data.length) break
      const remaining = Math.min(winSize - bytesSent, data.length - chunkOffset)
      const chunkLen = Math.min(chunkSize, remaining)
      const payload = data.subarray(chunkOffset, chunkOffset + chunkLen)

      const crc = crc16xmodem(payload)
      const body = new Uint8Array(5 + payload.length)
      body[0] = this.seq & 0xff
      body[1] = 0x1d
      body[2] = slot & 0x07
      body[3] = (crc >> 8) & 0xff
      body[4] = crc & 0xff
      body.set(payload, 5)
      await this.writeAe01(buildFrame(FLAG_DATA, CMD_DATA, body))

      this.seq = (this.seq + 1) & 0xff
      slot = (slot + 1) & 0x07
      bytesSent += chunkLen
      chunks++
      onReached(chunkOffset + chunkLen)
    }
    this.log('tx', `window: ${chunks} chunks from offset ${offset} (${bytesSent}B)`)
  }

  private buildMetaBody(size: number, crc: number, name: string): Uint8Array {
    const nameBytes = new TextEncoder().encode(name)
    const body = new Uint8Array(1 + 4 + 2 + nameBytes.length + 1)
    let p = 0
    body[p++] = this.seq
    body[p++] = (size >>> 24) & 0xff
    body[p++] = (size >>> 16) & 0xff
    body[p++] = (size >>> 8) & 0xff
    body[p++] = size & 0xff
    body[p++] = (crc >> 8) & 0xff
    body[p++] = crc & 0xff
    body.set(nameBytes, p)
    p += nameBytes.length
    body[p] = 0x00
    return body
  }

  private buildFilePathResponse(devSeq: number): Uint8Array {
    const d = new Date()
    const z = (n: number, w = 2) => n.toString().padStart(w, '0')
    const dateStr = `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`
    const ext = this.uploadMode === 'animation' ? '.avi' : '.jpg'
    const path = `啜${dateStr}${ext}`
    const u16 = new Uint8Array(path.length * 2 + 2) // trailing UTF-16 null
    for (let i = 0; i < path.length; i++) {
      const c = path.charCodeAt(i)
      u16[i * 2] = c & 0xff
      u16[i * 2 + 1] = (c >> 8) & 0xff
    }
    const resp = new Uint8Array(2 + u16.length)
    resp[0] = 0x00
    resp[1] = devSeq
    resp.set(u16, 2)
    return resp
  }

  private tempName(): string {
    const r = crypto.getRandomValues(new Uint8Array(4))
    let s = ''
    for (const b of r) s += b.toString(16).padStart(2, '0')
    return `${s}.tmp` // 8 hex + .tmp = 12 chars
  }
}
