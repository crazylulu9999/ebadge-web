# Handoff — GIF / slideshow / animation support

Context for continuing **ebadge-web** in Claude Code. v1 (static JPEG upload) works
end-to-end on hardware. This doc covers adding animated content.

> **STATUS (implemented, 2026-06-16):** GIF + slideshow → MJPG-AVI is implemented
> in code and passes build + unit tests, but is **NOT yet confirmed on hardware**.
> New files: `src/avi.ts` (verified-reference AVI muxer), `src/media-frames.ts`
> (WebCodecs GIF/slideshow frame decode). `src/e87-client.ts` generalized to
> `uploadFile(bytes, {mode})` with `uploadJpeg`/`uploadAnimation` wrappers;
> `src/image.ts` gained `fileToBadgeAnimation`/`filesToBadgeAnimation`; the UI
> accepts GIF + multi-select. AVI bytes are unit-tested in `tests/avi.selftest.ts`
> (`pnpm test` runs it). **Next: confirm a real GIF animates on the badge.**

## What already works (don't re-derive)

- Badge: **JieLi AC697**, JieLi RCSP. App = Web Bluetooth + TypeScript (Vite, pnpm).
- GATT: service `0000ae00` → `ae01` (writeNR: commands+data) / `ae02` (notify).
  Sideband service `c2e6fd00-e966-1000-8000-bef9c223df6a` → `fd01/03/05` notify,
  `fd02` write (9E-prefixed control).
- Upload flow (in `src/e87-client.ts`): connect → subscribe → **auth once per
  connection** (raw 00/01/02 challenge–response, cipher in `src/jl-auth.ts`,
  verified vector) → control handshake (cmd 0x06,0x03,0x07,0x21,0x27 + fd02 writes)
  → file meta (cmd 0x1b: size BE32 + CRC16/XMODEM of whole file + `<8hex>.tmp`) →
  **offset-driven windowed data** → completion (cmd 0x20 path response, cmd 0x1c).
- Offset-driven transfer is the key subtlety: each `0x1d` ack carries
  `winSize` (body[2..3] BE16) and `nextOffset` (body[4..7] BE32). Send chunks
  starting at `nextOffset`. The badge requests **offset 0 last** as the "commit
  chunk", which triggers cmd 0x20. Loop ends only on 0x20/0x1c.
- Frame: `FE DC BA | flag | cmd | len(BE16) | body | EF`. Data frame body:
  `[seq][0x1d][slot 0-7][crc16_hi][crc16_lo][<=490 bytes]`. flag 0x80, cmd 0x01.
- Image spec: **368×368 JPEG**, adaptive quality to <=60KB (`src/image.ts`).
- Badge applies the image **only after the BLE link drops** (by spec — not a bug).
  We keep the connection open for consecutive sends; auth is skipped on reuse
  (`authenticated` flag). NOTE: consecutive multi-send on one connection was the
  last change and still needs a clean hardware re-confirm.

## The animation insight

GIF / slideshow / short video use the **exact same upload path**. Only two things
differ from a still image:

1. The file bytes are an **MJPG AVI container** (motion-JPEG frames in an AVI),
   not a single JPEG. The badge plays the AVI.
2. The completion path response (cmd 0x20) uses extension **`.avi`** instead of
   `.jpg`. Everything else (0x1b meta with whole-file size + CRC16, windowed
   offset-driven transfer, commit chunk, 0x1c) is identical.

So: **no new protocol work.** It's (a) building the AVI bytes and (b) one mode flag.

## Reference code to port (MIT — already in our memory notes)

Repo `hybridherbst/web-bluetooth-e87`, under `web/src/`:
- `avi-builder.ts` → `buildMjpgAvi(frames, fps)` — the AVI muxer. Port nearly as-is.
- `lib/image-processing.ts` → `imagesToPreviewBitmaps`, `videoToPreviewBitmaps`,
  `previewBitmapsToAvi` — frame extraction + AVI assembly helpers.
- `lib/e87-protocol.ts` → `writeFileE87` + `UploadMode` — shows how `.avi` is
  selected in the path response (our `buildFilePathResponse`).
Repo `jumpingmushroom/e87_badge` `docs/protocol.md` — wire-level cross-check.

## Concrete change plan (in our codebase)

1. **Generalize the client.** In `src/e87-client.ts`, extract the body of
   `uploadJpeg` into `uploadFile(bytes: Uint8Array, opts?: { mode?: 'image' |
   'animation' }, onProgress?)`. Keep `uploadJpeg` as a thin wrapper
   (`mode:'image'`). Pass the mode down to `buildFilePathResponse(devSeq, mode)`
   and switch ext: `mode === 'animation' ? '.avi' : '.jpg'`. The temp name in
   cmd 0x1b can stay `<hex>.tmp` (unchanged).

2. **Add `src/avi.ts`** — port `buildMjpgAvi(jpegFrames: Uint8Array[], fps)`.
   Each frame is already a JPEG (reuse the 368×368 encoder). Returns AVI bytes.

3. **Extend `src/image.ts`**:
   - `gifToFrames(file, maxFps)` — decode GIF to frames. Use WebCodecs
     `ImageDecoder` (Chrome target) to read frames + per-frame durations, draw
     each to a 368×368 canvas, JPEG-encode. Honor a frame cap to keep file size
     sane (badge max unknown; README says GIF/slideshow 30–60s; keep modest).
   - `imagesToFrames(files[], frameMs)` — slideshow from stills.
   - Produce `{ aviBytes, frameCount, fps, sizeBytes }`.

4. **UI (`src/main.ts` / `index.html`)**:
   - Accept `image/gif` and multi-file selection.
   - On GIF or multi-select → build AVI → show frame count/size → upload with
     `mode:'animation'`.
   - Same adaptive-size guard idea: if AVI too big, reduce per-frame quality or
     drop fps.

5. **Build / verify**: `pnpm build` (tsc + vite). Keep the auth unit test green
   (`pnpm test`). Then hardware test: `pnpm dev`, open localhost in Chrome, send
   a small GIF, confirm it animates on the badge.

## Gotchas learned this session

- Web Bluetooth = Chrome/Edge desktop or Android only; HTTPS/localhost required.
- MTU: data frames are 503 bytes on the wire; Chrome negotiates MTU 517 so a
  single writeValueWithoutResponse works. Don't manually fragment.
- TS 5.7+ made `Uint8Array` generic over ArrayBufferLike → cast args to
  `BufferSource` when calling `writeValueWithoutResponse`.
- The cmd 0x20 completion has a tight (~100ms) device timeout → we auto-respond
  in the notification handler, not the polled loop. Keep that for animation too.
- Single-file build (`e87-badge.html`) was produced via esbuild for quick local
  testing without a dev server; regenerate it if you want, or just use `pnpm dev`.

## Remaining for animation
- **Hardware confirm**: send a small GIF and a 2–3 image slideshow; confirm they
  animate on the badge. The AVI container is unit-tested but the firmware's real
  fps/frame-count/file-size limits are unverified (`TARGET_MAX_ANIMATION_BYTES`
  in `src/image.ts` is a 500 KB heuristic — tune once hardware data exists).
- Variable GIF delays are reconciled to one fixed AVI fps via `fpsFromFrames`
  (average, clamped 1–30). If precise per-frame timing matters, resample
  (duplicate frames into fixed-rate slots) — see the note in `src/media-frames.ts`.
- `e87-badge.html` (standalone single-file build) is now **stale** — it predates
  animation. Regenerate from `src/` if you still want a no-dev-server build, or
  drop it in favor of `pnpm dev` / the Pages deploy.

## Open items unrelated to animation
- Confirm consecutive multi-send on one connection works on hardware.
- ✅ GitHub Pages live and green at https://crazylulu9999.github.io/ebadge-web/.
- ✅ Dependabot PRs merged (typescript 6, @types/web-bluetooth); deps audit clean.
- Optional RCSP reads: battery, firmware version, gallery list/delete (fd02/fd01).
