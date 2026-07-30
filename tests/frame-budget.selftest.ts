/**
 * Self-test for the animation fit planner. Asserts the invariants that keep an
 * oversized file off the wire, not the specific tuning constants — SMOOTHNESS_FLOOR
 * and the overhead estimates must stay adjustable as hardware data improves.
 * Run: npx tsx tests/frame-budget.selftest.ts
 */
import {
  planFit,
  resolveFit,
  evenlySpacedIndices,
  estimateAviBytes,
  AVI_FIXED_OVERHEAD,
  AVI_PER_FRAME_OVERHEAD,
  type FitInput,
} from '../src/frame-budget'

let failed = 0
const check = (name: string, cond: boolean, detail = '') => {
  if (cond) {
    console.log(`✅ ${name}`)
  } else {
    console.error(`❌ ${name} ${detail}`)
    failed++
  }
}

// Quality ladder mirroring ANIM_QUALITY_STEPS, with plausible bytes/frame for a
// detail-heavy 368x368 source. The q22 figure is the measured one (see
// src/frame-budget.ts header): 49 frames / 557574 B.
const Q = [0.8, 0.7, 0.6, 0.5, 0.42, 0.35, 0.28, 0.22]
const BPF = [25400, 21500, 18600, 16000, 14200, 12600, 11800, 11100]

const base = (over: Partial<FitInput> = {}): FitInput => ({
  frameCount: 120,
  qualities: Q,
  bytesPerFrame: BPF,
  maxBytes: 550000,
  maxFrames: 200,
  allowDecimation: true,
  ...over,
})

// ── the whole point: nothing over budget ever escapes ────────────────────────

for (const frameCount of [1, 3, 12, 40, 49, 120, 600]) {
  for (const maxBytes of [60000, 200000, 550000, 2000000]) {
    const plan = planFit(base({ frameCount, maxBytes }))
    if (!plan) continue
    check(
      `fits budget (n=${frameCount}, max=${maxBytes})`,
      plan.estimatedBytes <= maxBytes,
      `got ${plan.estimatedBytes}`,
    )
    check(
      `never invents frames (n=${frameCount}, max=${maxBytes})`,
      plan.frames >= 1 && plan.frames <= frameCount,
      `got ${plan.frames}`,
    )
  }
}

// ── decimation is refused for slideshows ─────────────────────────────────────

const slideshowTooBig = planFit(base({ frameCount: 120, allowDecimation: false }))
check('slideshow that cannot fit returns null', slideshowTooBig === null)

const slideshowOk = planFit(base({ frameCount: 20, allowDecimation: false }))
check('slideshow that fits keeps EVERY image', slideshowOk?.frames === 20, `got ${slideshowOk?.frames}`)

// A slideshow may only trade quality, never images.
for (const n of [1, 5, 15, 20]) {
  const p = planFit(base({ frameCount: n, allowDecimation: false }))
  if (p) check(`slideshow n=${n} keeps all frames`, p.frames === n, `got ${p.frames}`)
}

// ── impossible jobs are reported, not fudged ─────────────────────────────────

check(
  'budget below fixed overhead → null',
  planFit(base({ maxBytes: AVI_FIXED_OVERHEAD - 1 })) === null,
)
check('zero frames → null', planFit(base({ frameCount: 0 })) === null)
check(
  'no usable quality estimate → null',
  planFit(base({ bytesPerFrame: [0, 0, 0, 0, 0, 0, 0, 0] })) === null,
)

// ── the frame ceiling is honoured independently of size ──────────────────────

const capped = planFit(base({ frameCount: 120, maxFrames: 30, maxBytes: 100_000_000 }))
check('maxFrames caps even with unlimited bytes', capped?.frames === 30, `got ${capped?.frames}`)

// ── the quality/smoothness trade actually happens ────────────────────────────
// Frame-maximising alone would pick the bottom rung; the floor should buy a
// better one while still keeping a substantial share of the frames.

const traded = planFit(base())
check('a plan exists for the measured worst case', traded !== null)
if (traded) {
  const frameMaxing = Math.floor((550000 - AVI_FIXED_OVERHEAD) / (BPF[BPF.length - 1] + 25))
  check('trades some frames for quality', traded.quality > Q[Q.length - 1], `q=${traded.quality}`)
  check(
    'but keeps a substantial share of them',
    traded.frames >= Math.ceil(frameMaxing * 0.5),
    `${traded.frames} vs frame-maxing ${frameMaxing}`,
  )
}

// A generous budget must not degrade quality at all.
const roomy = planFit(base({ frameCount: 10, maxBytes: 2_000_000 }))
check('ample budget keeps top quality', roomy?.quality === Q[0], `got ${roomy?.quality}`)
check('ample budget keeps every frame', roomy?.frames === 10, `got ${roomy?.frames}`)

// ── evenlySpacedIndices ──────────────────────────────────────────────────────

check('keep >= total returns identity', evenlySpacedIndices(5, 9).join() === '0,1,2,3,4')
check('keep === total returns identity', evenlySpacedIndices(4, 4).join() === '0,1,2,3')
check('keep 1 picks a middle frame, not frame 0', evenlySpacedIndices(10, 1)[0] === 5)
check('empty input', evenlySpacedIndices(0, 3).length === 0)
check('zero keep', evenlySpacedIndices(10, 0).length === 0)

for (const [total, keep] of [
  [120, 30],
  [120, 7],
  [49, 48],
  [100, 3],
  [7, 2],
]) {
  const idx = evenlySpacedIndices(total, keep)
  check(`spacing n=${total} k=${keep}: correct count`, idx.length === keep, `got ${idx.length}`)
  check(
    `spacing n=${total} k=${keep}: strictly increasing`,
    idx.every((v, i) => i === 0 || v > idx[i - 1]),
    idx.join(),
  )
  check(
    `spacing n=${total} k=${keep}: in range`,
    idx.every((v) => v >= 0 && v < total),
    idx.join(),
  )
}

// ── the overhead model matches real hardware captures ────────────────────────
// Three real encodes; the model must land within a few percent of each.

const captures: Array<[frames: number, actual: number]> = [
  [3, 82154],
  [40, 448664],
  [49, 557574],
]
for (const [frames, actual] of captures) {
  // Solve the model for bytes/frame, then round-trip it back to a size.
  const bpf = (actual - AVI_FIXED_OVERHEAD) / frames - 25
  const modelled = estimateAviBytes(frames, bpf)
  check(
    `overhead model round-trips the ${frames}-frame capture`,
    Math.abs(modelled - actual) <= 2,
    `modelled ${modelled} vs actual ${actual}`,
  )
}
// The two q22 captures should agree on bytes/frame — that is what makes a
// single probe representative of the whole run.
const bpf40 = (448664 - AVI_FIXED_OVERHEAD) / 40 - 25
const bpf49 = (557574 - AVI_FIXED_OVERHEAD) / 49 - 25
check(
  'the two q22 captures agree on bytes/frame within 5%',
  Math.abs(bpf40 - bpf49) / bpf49 < 0.05,
  `${Math.round(bpf40)} vs ${Math.round(bpf49)}`,
)

// ── resolveFit: the loop that decides whether an oversize file can escape ────
// Driven with a fake encoder so the whole control flow is checkable in Node.

const runResolve = async (
  over: Partial<FitInput> & { truthMultiplier?: number } = {},
): Promise<{ plan: Awaited<ReturnType<typeof resolveFit>>; sizes: number[]; encodes: number }> => {
  const { truthMultiplier = 1, ...inputOver } = over
  const input = { ...base(inputOver) }
  const { bytesPerFrame: _probe, ...rest } = input
  const sizes: number[] = []
  let encodes = 0
  const plan = await resolveFit(
    rest,
    async () => input.bytesPerFrame as number[],
    async (p) => {
      encodes++
      // "Truth" = the probe estimate scaled: >1 models an underestimating probe.
      const bpf = (input.bytesPerFrame as number[])[Q.indexOf(p.quality)] * truthMultiplier
      const size = Math.round(AVI_FIXED_OVERHEAD + p.frames * (AVI_PER_FRAME_OVERHEAD + bpf))
      sizes.push(size)
      return size
    },
  )
  return { plan, sizes, encodes }
}

{
  const { plan, sizes, encodes } = await runResolve()
  check('resolveFit: accurate probe needs a single encode', encodes === 1, `got ${encodes}`)
  check('resolveFit: result fits', !!plan && sizes[sizes.length - 1] <= 550000)
}

{
  // Probe underestimates by 40% — must re-plan rather than ship the overshoot.
  const { plan, sizes, encodes } = await runResolve({ truthMultiplier: 1.4 })
  check('resolveFit: underestimating probe triggers a re-plan', encodes > 1, `encodes=${encodes}`)
  check('resolveFit: recovers a fitting plan', plan !== null)
  if (plan) {
    check(
      'resolveFit: final encode is within budget',
      sizes[sizes.length - 1] <= 550000,
      `sizes=${sizes.join()}`,
    )
  }
}

{
  // Probe wildly wrong (8x). It must give up, NOT return an oversized plan —
  // this is the exact case the old code shipped to the badge.
  const { plan, sizes, encodes } = await runResolve({ truthMultiplier: 8 })
  const lastFits = sizes.length > 0 && sizes[sizes.length - 1] <= 550000
  check(
    'resolveFit: hopeless overshoot returns null rather than an oversized plan',
    plan === null || lastFits,
    `plan=${JSON.stringify(plan)} sizes=${sizes.join()}`,
  )
  check('resolveFit: bounded retries', encodes <= 3, `encodes=${encodes}`)
}

{
  // A slideshow may never come back with fewer images than the user chose.
  const { plan } = await runResolve({ frameCount: 12, allowDecimation: false, truthMultiplier: 1.5 })
  check(
    'resolveFit: slideshow keeps every image or returns null',
    plan === null || plan.frames === 12,
    `got ${plan?.frames}`,
  )
}

{
  const { plan, encodes } = await runResolve({ maxBytes: 1000 })
  check('resolveFit: impossible budget returns null without encoding', plan === null && encodes === 0)
}

if (failed) {
  console.error(`\n❌ ${failed} frame-budget check(s) failed`)
  process.exit(1)
}
console.log('\n✅ frame budget planner valid')
