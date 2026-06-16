# ebadge-web

Web Bluetooth + TypeScript controller for the **E87 / L8** round LED pin badge
(the one that normally pairs with the **ZRun** app, `com.zijun.zrun`). Connects,
authenticates, and uploads an image straight from the browser — no app required.

The badge is a **JieLi AC697** SoC speaking JieLi RCSP. The full upload protocol
(auth handshake, framing, windowed transfer, CRC) was reverse-engineered by
[hybridherbst/web-bluetooth-e87](https://github.com/hybridherbst/web-bluetooth-e87)
and [jumpingmushroom/e87_badge](https://github.com/jumpingmushroom/e87_badge)
(both MIT). This project is a clean TypeScript port of the image-upload path.

## Browser support

Web Bluetooth only. Works in **Chrome / Edge on desktop and Android**. **iOS Safari
does not support Web Bluetooth** and cannot run this. Requires HTTPS (GitHub Pages
provides it) or `localhost`.

## Develop

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # static output in dist/
npm test         # verify auth cipher against captured vector (npx tsx tests/auth.test.ts)
```

## Deploy to GitHub Pages

1. Push this folder to a new GitHub repo (e.g. `ebadge-web`).
2. Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. The included workflow (`.github/workflows/deploy.yml`) builds on every push to
   `main` and publishes `dist/`. Your app lands at
   `https://<user>.github.io/ebadge-web/`.

`vite.config.ts` uses `base: './'` (relative paths) so it works under the repo
subpath without hardcoding the repo name.

## Usage

1. Single-press the badge's Bluetooth button so it advertises as `E87`.
2. Open the page, click **배지 연결**, pick the badge in the chooser.
3. Choose an image (auto center-cropped to 368×368 and JPEG-encoded).
4. Click **배지로 전송**. Watch the log; an upload takes ~5–15 s.

## How it works

| Stage | Channel | Notes |
|---|---|---|
| Auth | `ae01`/`ae02` raw | 6-message mutual challenge/response, JieLi custom cipher (`src/jl-auth.ts`, verified vector) |
| Control | `ae01`/`ae02` framed | `FE DC BA · flag · cmd · len · body · EF`; phases 0x06→0x03→0x07→0x21→0x27→0x1B |
| Sideband | `fd02` write / `fd01`,`fd03`,`fd05` notify | 9E-prefixed RCSP control (time, heartbeat, ready) |
| Data | `ae01` framed | 490-byte JPEG chunks, per-chunk CRC-16/XMODEM, 8-frame windows |
| Done | `ae01`/`ae02` framed | `0x20` complete + `0x1C` finalize handshake |

## Status / caveats

- Image upload is implemented and the auth cipher is verified against the captured
  test vector. **Not yet tested end-to-end against hardware from this port** — test
  on your badge and check the log if anything stalls.
- The completion handshake (phase 10) sends a generated UTF-16LE path; the image is
  typically already stored before this. Completion errors are logged, not fatal.
- Text rendering, GIF/slideshow (AVI), and danmaku are out of scope for v1 — the
  reference repos have that code if you want to extend.

## Credits

Protocol © the reverse-engineering work of hybridherbst and jumpingmushroom (MIT).
Auth cipher tables/algorithm ported from `web-bluetooth-e87`.
