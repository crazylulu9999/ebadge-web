/**
 * Choosing how many frames, at what JPEG quality, an animation may use.
 *
 * WHY THIS EXISTS — measured on hardware 2026-07-30 (E87 badge):
 *
 *     3 frames /  82 KB  -> plays
 *    40 frames / 449 KB  -> plays
 *    49 frames / 558 KB  -> plays
 *   120 frames / 890 KB  -> uploads cleanly, badge shows NOTHING
 *   120 frames / 1.72 MB -> uploads cleanly, badge shows NOTHING
 *
 * The old code walked a quality ladder and, when even the lowest rung missed
 * the budget, set `overBudget: true` and uploaded anyway. That is the worst
 * available outcome: the picture is crushed to 22% quality, the file is still
 * too big, the transfer burns four minutes at ~6.5 KB/s, and the badge ends up
 * blank. A budget the encoder does not enforce is not a budget.
 *
 * So: plan first, encode once. Estimating bytes-per-frame from a handful of
 * probe encodes lets us solve for (frames, quality) directly instead of
 * re-encoding every frame up to eight times, which also makes the whole encode
 * roughly an order of magnitude cheaper.
 *
 * DOM-free on purpose — this is the only non-obvious arithmetic in the encode
 * path, so it is the part that gets unit-tested in Node.
 */

// ── AVI container overhead ───────────────────────────────────
// Derived from buildMjpgAvi in src/avi.ts, which pins 'movi' to a fixed offset:
//   5742  bytes of headers before the movi LIST
//   + 12  movi LIST header ('LIST' + size + 'movi')
//   +  8  idx1 chunk header
//   per frame: 8 ('00dc' + size) + 16 (idx1 entry) + up to 1 pad byte
// Cross-checked against three real encodes: 3f/82154B, 40f/448664B, 49f/557574B
// give 25439, 11048 and 11236 bytes/frame respectively — and the two q22 runs
// agree to within 2%, which is the accuracy this model needs.

/** Bytes an AVI costs before any frame payload. */
export const AVI_FIXED_OVERHEAD = 5762
/** Per-frame container cost: chunk header + index entry + average pad. */
export const AVI_PER_FRAME_OVERHEAD = 25

/** Exact-ish size prediction for `frameCount` frames averaging `bytesPerFrame`. */
export function estimateAviBytes(frameCount: number, bytesPerFrame: number): number {
  return AVI_FIXED_OVERHEAD + frameCount * (AVI_PER_FRAME_OVERHEAD + bytesPerFrame)
}

// ── Frame selection ──────────────────────────────────────────

/**
 * Indices of `keep` frames spread evenly across `total`.
 *
 * Samples at the MIDPOINT of each output slot rather than stretching first-to-
 * last: on a looping animation the endpoints are often near-identical, and
 * including both wastes one of very few frames on a duplicate.
 */
export function evenlySpacedIndices(total: number, keep: number): number[] {
  if (total <= 0 || keep <= 0) return []
  if (keep >= total) return Array.from({ length: total }, (_, i) => i)
  if (keep === 1) return [Math.floor(total / 2)]
  const out: number[] = new Array(keep)
  for (let i = 0; i < keep; i++) {
    // step = total/keep > 1, so these are strictly increasing and unique.
    out[i] = Math.min(total - 1, Math.floor(((i + 0.5) * total) / keep))
  }
  return out
}

// ── Fit planning ─────────────────────────────────────────────

export interface FitInput {
  /** Frames the source actually produced. */
  frameCount: number
  /** Quality ladder, best first. */
  qualities: readonly number[]
  /** Estimated encoded bytes for ONE frame at each quality (same order). */
  bytesPerFrame: readonly number[]
  maxBytes: number
  /** Firmware frame ceiling, independent of size. */
  maxFrames: number
  /**
   * false for slideshows. Their frames are distinct images the user chose, so
   * dropping one silently discards their content — quality is the only honest
   * lever there, and if that is not enough the caller must refuse the job
   * rather than quietly deliver a different slideshow.
   */
  allowDecimation: boolean
}

export interface FitPlan {
  frames: number
  quality: number
  estimatedBytes: number
}

/**
 * Smallest share of the frame-maximising option we will accept in order to buy
 * a better quality rung.
 *
 * Pure judgement, and the one number here worth arguing about. The panel is a
 * 368x368 circle worn on a shirt: at that size a legible frame beats a smooth
 * one, and quality 22% is visibly blocky. 0.65 means we will give up about a
 * third of the frames for sharper ones, but no more. Tests assert the
 * invariants, not this value, so it stays tunable.
 */
export const SMOOTHNESS_FLOOR = 0.65

/**
 * Pick the best (frames, quality) pair that fits the budget, or null when the
 * source cannot be made to fit at all.
 *
 * Returning null is a real answer, not a failure to try: the caller surfaces it
 * as "this is too long / too many images", which is something the user can act
 * on. Shipping an oversized file is not.
 */
export function planFit(input: FitInput): FitPlan | null {
  const { frameCount, qualities, bytesPerFrame, maxBytes, maxFrames, allowDecimation } = input
  if (frameCount < 1) return null
  const frameCeiling = Math.min(frameCount, Math.max(1, maxFrames))

  const candidates: FitPlan[] = []
  for (let i = 0; i < qualities.length; i++) {
    const bpf = bytesPerFrame[i]
    if (!(bpf > 0)) continue
    // Largest n satisfying AVI_FIXED + n*(PER_FRAME + bpf) <= maxBytes.
    const affordable = Math.floor(
      (maxBytes - AVI_FIXED_OVERHEAD) / (bpf + AVI_PER_FRAME_OVERHEAD),
    )
    const frames = Math.min(frameCeiling, affordable)
    if (frames < 1) continue
    // A slideshow that cannot carry every image is not this slideshow.
    if (!allowDecimation && frames < frameCount) continue
    candidates.push({
      frames,
      quality: qualities[i],
      estimatedBytes: estimateAviBytes(frames, bpf),
    })
  }
  if (candidates.length === 0) return null

  let bestFrames = 0
  for (const c of candidates) if (c.frames > bestFrames) bestFrames = c.frames
  const floor = Math.max(1, Math.ceil(bestFrames * SMOOTHNESS_FLOOR))

  // Among the options that keep enough frames, take the sharpest.
  let chosen: FitPlan | null = null
  for (const c of candidates) {
    if (c.frames < floor) continue
    if (!chosen || c.quality > chosen.quality) chosen = c
  }
  return chosen
}

// ── Plan → encode → verify ───────────────────────────────────

/** Extra attempts allowed when a real encode overshoots the probe estimate. */
export const MAX_REPLANS = 2

/**
 * Settle on a plan whose REAL encoded size fits, or return null.
 *
 * `probe` gives a cheap per-quality bytes-per-frame estimate; `encode` performs
 * the actual encode and reports its true size. Three probe frames matched two
 * independent hardware captures within 2%, but content whose detail varies can
 * still overshoot — so a miss re-scales the estimate by the observed error and
 * re-plans rather than shipping the overshoot.
 *
 * Split out from the canvas code so this control flow — the part that decides
 * whether an oversized file can escape — is testable in Node with a fake encoder.
 */
export async function resolveFit(
  input: Omit<FitInput, 'bytesPerFrame'>,
  probe: () => Promise<number[]>,
  encode: (plan: FitPlan) => Promise<number>,
  maxReplans: number = MAX_REPLANS,
): Promise<FitPlan | null> {
  let bytesPerFrame = await probe()
  let plan = planFit({ ...input, bytesPerFrame })
  if (!plan) return null

  let actual = await encode(plan)
  for (let attempt = 0; actual > input.maxBytes && attempt < maxReplans; attempt++) {
    // What the encode really cost per frame, versus what we assumed for the
    // quality we picked. Scale every rung by that error and try again.
    const measured = (actual - AVI_FIXED_OVERHEAD) / plan.frames - AVI_PER_FRAME_OVERHEAD
    const assumed = bytesPerFrame[input.qualities.indexOf(plan.quality)]
    if (!(measured > 0) || !(assumed > 0)) return null
    const ratio = measured / assumed
    // A ratio at or below 1 means the encode did NOT overshoot per-frame, so
    // re-planning would return the same plan and loop pointlessly.
    if (!(ratio > 1)) return null
    bytesPerFrame = bytesPerFrame.map((b) => b * ratio)
    const next = planFit({ ...input, bytesPerFrame })
    if (!next) return null
    plan = next
    actual = await encode(plan)
  }
  return actual <= input.maxBytes ? plan : null
}
