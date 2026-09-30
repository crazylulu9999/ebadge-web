# Handoff — GIF / slideshow / animation support

Context for continuing **ebadge-web** in Claude Code. v1 (static JPEG upload) works
end-to-end on hardware. This doc covers adding animated content.

> **STATUS (implemented, 2026-06-16):** GIF + slideshow + **video** → MJPG-AVI is
> implemented in code and passes build + unit tests, but is **NOT yet confirmed on
> hardware**. New files: `src/avi.ts` (verified-reference AVI muxer),
> `src/media-frames.ts` (frame decode: WebCodecs `ImageDecoder` for GIF,
> `HTMLVideoElement` seek for video — both zero-dep, Chrome/Edge). `src/e87-client.ts`
> generalized to `uploadFile(bytes, {mode})` with `uploadJpeg`/`uploadAnimation`
> wrappers; `src/image.ts` gained `fileToBadgeAnimation` / `filesToBadgeAnimation` /
> `videoToBadgeAnimation`; the UI accepts GIF + video + multi-select. AVI bytes are
> unit-tested in `tests/avi.selftest.ts` (`pnpm test` runs it). **Next: confirm a
> real GIF/video animates on the badge.**

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
- The old single-file esbuild build (`e87-badge.html`) has been **removed** — it
  predated animation and was referenced by nothing in the build. Use `pnpm dev`
  or the Pages deploy; recover it from git (`edc1e63`) if you ever want it back.

## Hardware results (2026-07-30)

✅ **The animation path works.** A 3-image slideshow played on the badge, which
clears the whole `.avi` chain at once: `buildMjpgAvi`'s container, the `.avi`
extension in `buildFilePathResponse`, and low frame rates (2 fps).

**The failure was size, and it is silent.** Oversized animations upload with a
clean protocol trace — meta acked, every window acked, `0x20`/`0x1c` handshake
complete, `✅ upload complete` — and then the badge displays nothing.

| frames | bytes | plays |
|---|---|---|
| 3 | 82,154 | ✅ |
| 40 | 448,664 | ✅ |
| 49 | 557,574 | ✅ |
| 120 | 890,792 | ❌ |
| 120 | 1,723,312 | ❌ |

Quality is NOT a factor — the 449 KB and 558 KB runs were both q22 and played
fine. Measured transfer rate is ~6.5 KB/s, so 550 KB already costs ~85 s.

`TARGET_MAX_ANIMATION_BYTES` is now **550000** and is **enforced**: `framesToAvi`
probes a few frames, solves for (frames, quality) via `src/frame-budget.ts`, and
refuses the job rather than shipping an oversized file. Slideshows never drop a
frame (each is an image the user chose) — they refuse instead; GIF/video are
thinned with `evenlySpacedIndices` and the fps recomputed.

## Remaining for animation
- **Narrow the ceiling**: the limit is somewhere in 558 KB–890 KB. Two captures
  would settle it — ~60 images (~700 KB), and 100+ *simple* images (many frames,
  few bytes) to separate a frame-count limit from a byte limit. `MAX_ANIMATION_FRAMES`
  exists as a separate knob for exactly that and is currently a no-op at 120.
- **Video** is sampled via `videoToFrames` (`src/media-frames.ts`): off-DOM
  `HTMLVideoElement` seek-and-draw, default 10 fps · first 12 s · ≤120 frames
  (all overridable via opts). No node unit test — HTMLVideoElement is browser-only;
  verify with `pnpm dev`. Codec support is the browser's (Chrome/Edge: H.264 mp4,
  VP8/9 webm; HEVC/AV1 may not decode).
- Variable GIF delays are reconciled to one fixed AVI fps via `fpsFromFrames`
  (average, clamped 1–30). If precise per-frame timing matters, resample
  (duplicate frames into fixed-rate slots) — see the note in `src/media-frames.ts`.
- ✅ `e87-badge.html` (stale standalone build, predating animation) was removed —
  see the note above.

## Open items unrelated to animation
- Confirm consecutive multi-send on one connection works on hardware.
- ✅ GitHub Pages live and green at https://crazylulu9999.github.io/ebadge-web/.
- ✅ Dependabot PRs merged (typescript 6, @types/web-bluetooth); deps audit clean.
- Optional RCSP reads: battery, firmware version, gallery list/delete (fd02/fd01).
