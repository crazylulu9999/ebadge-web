/**
 * Verifies the JieLi auth cipher against the captured test vector.
 * Run: npx tsx tests/auth.test.ts
 */
import { encryptChallenge } from '../src/jl-auth'

const challenge = Uint8Array.of(
  0x70, 0xb7, 0x59, 0x92, 0xe0, 0x5e, 0xa7, 0x8f,
  0xec, 0x53, 0x3b, 0xa1, 0x29, 0x79, 0xb5, 0x90,
)
const expected = Uint8Array.of(
  0xff, 0xe9, 0xe6, 0xc8, 0x0c, 0xe1, 0xf4, 0x0f,
  0x5c, 0xce, 0xae, 0x20, 0x83, 0x1c, 0x58, 0x79,
)

const got = encryptChallenge(challenge)
const hex = (a: Uint8Array) => Array.from(a).map((b) => b.toString(16).padStart(2, '0')).join(' ')

const ok = got.length === expected.length && got.every((b, i) => b === expected[i])
console.log('expected:', hex(expected))
console.log('got:     ', hex(got))
if (!ok) {
  console.error('❌ AUTH VECTOR MISMATCH')
  process.exit(1)
}
console.log('✅ auth cipher matches captured test vector')
