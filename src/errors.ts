/**
 * User-facing text for errors that reach the UI.
 *
 * The module boundary is the rule, and it is stable because it follows who the
 * message was written for:
 *
 *   image.ts / media-frames.ts  throw Korean copy aimed at the user
 *                               ('…Chrome/Edge에서 열어주세요.') — surfaced verbatim,
 *                               so those sites need nothing from this file.
 *   e87-client.ts               throws English protocol diagnostics
 *                               ('not connected', 'timeout waiting for badge
 *                               response') — those must be translated here.
 *
 * The raw message always reaches #log regardless; this only decides what the
 * banner says.
 */

/** Generic fallback for a throwable that carries no usable message. */
export const GENERIC_UPLOAD_ERROR = '전송에 실패했습니다. 아래 로그를 확인해 주세요.'

/**
 * Map a transfer error from `E87Client` to Korean user copy.
 *
 * Kept exhaustive-by-prefix rather than exact-match on the timeout case: the
 * client builds that message with context appended, so a substring test keeps
 * working if the wording gains detail.
 */
export function uploadErrorText(msg: string): string {
  if (msg === 'not connected') {
    return '배지와 연결되어 있지 않습니다. 다시 연결해 주세요.'
  }
  if (msg.includes('timeout')) {
    return '배지가 응답하지 않습니다. 배지의 블루투스 버튼을 다시 누른 뒤 재연결해 보세요.'
  }
  if (msg.includes('Web Bluetooth not supported')) {
    return '이 브라우저는 Web Bluetooth를 지원하지 않습니다.'
  }
  return GENERIC_UPLOAD_ERROR
}

/**
 * Text for a failed encode. Unlike transfers, the encoders already throw
 * specific, actionable Korean — discarding it for a generic line is pure loss,
 * so this only fills in when there is genuinely nothing to show.
 */
export function encodeErrorText(msg: string): string {
  return msg.trim() || '파일을 읽지 못했습니다.'
}
