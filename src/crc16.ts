/**
 * CRC-16/XMODEM — polynomial 0x1021, init 0x0000, no reflection, no final XOR.
 * Verified: crc16xmodem("123456789") === 0x31C3.
 *
 * Used in two places by the E87 protocol:
 *  - whole-file CRC in the CMD_START_LARGE_FILE_TRANSFER (0x1B) body
 *  - per-chunk CRC in every data frame
 */
export function crc16xmodem(data: Uint8Array): number {
  let crc = 0x0000
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i] << 8
    for (let j = 0; j < 8; j++) {
      if (crc & 0x8000) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff
      } else {
        crc = (crc << 1) & 0xffff
      }
    }
  }
  return crc & 0xffff
}
