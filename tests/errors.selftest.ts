/**
 * Self-test for the error-text mapping. Guards the one rule that is easy to get
 * backwards: encoder errors are already user-facing Korean and must survive
 * verbatim, while transfer errors are English diagnostics and must not.
 * Run: npx tsx tests/errors.selftest.ts
 */
import { uploadErrorText, encodeErrorText, GENERIC_UPLOAD_ERROR } from '../src/errors'

let failed = 0
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) {
    console.log(`✅ ${name}`)
  } else {
    console.error(`❌ ${name} ${detail}`)
    failed++
  }
}

// ── transfer errors: every e87-client throw site is translated ──────────────
// These strings are copied from src/e87-client.ts; if one changes there without
// changing here, this test is the thing that notices.

const notConnected = uploadErrorText('not connected')
check('not connected → Korean', /[가-힣]/.test(notConnected))
check('not connected → not the generic line', notConnected !== GENERIC_UPLOAD_ERROR)

const timedOut = uploadErrorText('timeout waiting for badge response')
check('timeout → Korean', /[가-힣]/.test(timedOut))
check('timeout → not the generic line', timedOut !== GENERIC_UPLOAD_ERROR)
check(
  'timeout matched by substring, not equality',
  uploadErrorText('timeout waiting for badge response (cmd 0x1d)') === timedOut,
  'a contextual suffix must not fall through to the generic line',
)

check(
  'unsupported browser → Korean',
  /[가-힣]/.test(uploadErrorText('Web Bluetooth not supported in this browser')),
)

check('unknown diagnostic → generic', uploadErrorText('EGATT_UNKNOWN 0x85') === GENERIC_UPLOAD_ERROR)
check('empty message → generic', uploadErrorText('') === GENERIC_UPLOAD_ERROR)

// No mapped transfer message may leak an English diagnostic to the banner.
for (const raw of ['not connected', 'timeout waiting for badge response', 'aborted']) {
  check(`"${raw}" is not shown raw`, uploadErrorText(raw) !== raw)
}

// ── encode errors: the encoders' own Korean copy passes through untouched ───

const gifErr = 'GIF 디코딩에는 WebCodecs(ImageDecoder)가 필요합니다. Chrome/Edge에서 열어주세요.'
check('encoder message survives verbatim', encodeErrorText(gifErr) === gifErr)

const codecErr = '동영상을 디코딩할 수 없습니다 (지원하지 않는 코덱/형식일 수 있어요).'
check('codec message survives verbatim', encodeErrorText(codecErr) === codecErr)

// imagesToFrames interpolates the user's filename — it must not be mangled.
const named = '이미지를 읽을 수 없습니다: photo (1).heic (지원하지 않는 형식일 수 있어요).'
check('filename-bearing message survives verbatim', encodeErrorText(named) === named)

check('empty encode message → fallback', encodeErrorText('') === '파일을 읽지 못했습니다.')
check('whitespace-only encode message → fallback', encodeErrorText('   ') === '파일을 읽지 못했습니다.')

if (failed) {
  console.error(`\n❌ ${failed} error-mapping check(s) failed`)
  process.exit(1)
}
console.log('\n✅ error text mapping valid')
