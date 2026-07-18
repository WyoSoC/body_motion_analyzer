// Task-dependent geometric FMS scoring — complements the DTW "Form" score
// (fms_dtw.js) with two additional categories:
//
//   Horizontal Symmetry — how closely the left side mirrors the right during
//     the movement. Self-contained: perfect L/R symmetry (0° difference) = 100.
//     No reference video needed.
//
//   Vertical Alignment — how little each body section's markers drift
//     horizontally (sway) as the body moves up/down. Less drift = better core
//     stacking. Normalized against the gold-standard reference, which scores
//     100 by construction; drifting more than the reference loses points.
//
// Each category is split into Upper / Trunk / Lower body sections. Only the
// Deep Squat is defined today; other tests return null (DTW-only) until their
// task-specific metrics are added.

import { FEATURES } from './fms_dtw.js'

// ── Metric builders (return a per-frame degrees value) ────────────
// A frame L is a 33-length array of {x, y, z} world landmarks (metres).

// Left/right angular discrepancy between two homologous joint angles.
function pairDiff(a, b) {
  return L => Math.abs(FEATURES[a](L) - FEATURES[b](L))
}

// Deviation from level (0°) — used for midline/trunk asymmetry (lateral tilt).
function offLevel(a) {
  return L => Math.abs(FEATURES[a](L))
}

// ── Bilateral symmetry metrics ────────────────────────────────────

// Symmetry Index (Robinson): 0 % = perfect symmetry. Reference-limb agnostic
// denominator (mean of the two limbs).
function symmetryIndex(l, r) {
  const denom = 0.5 * (Math.abs(l) + Math.abs(r))
  return denom === 0 ? 0 : (Math.abs(l - r) / denom) * 100
}

// Symmetry Angle: 0 % = perfect symmetry, standardized about 45°. Follows the
// user-specified formulation. (The canonical Zifchock 2008 SA divides by 90 and
// keeps the sign to encode which limb dominates; here we report magnitude.)
function symmetryAngle(l, r) {
  if (r === 0) return 0
  const alphaDeg = Math.atan(l / r) * 180 / Math.PI
  return Math.abs((alphaDeg - 45) / 45) * 100
}

// Frontal-plane trunk drift off the pelvis midline (metres). Assumes world-
// landmark X is the lateral axis — valid for the front/45° squat framing.
function trunkDeviation(L) {
  const midShoulderX = (L[11].x + L[12].x) / 2
  const midHipX      = (L[23].x + L[24].x) / 2
  return midShoulderX - midHipX
}

// ── Per-test configuration ────────────────────────────────────────
// symmetry sections: metrics = angle-discrepancy functions (deg per frame)
// vertical sections: indices = landmark indices whose horizontal drift is scored
export const GEO_TESTS = {
  'deep-squat': {
    diagnostics: true,  // emit SI/SA/trunk phase diagnostics
    symmetry: [
      { name: 'Upper Body', metrics: [pairDiff('shoulderL', 'shoulderR'), pairDiff('elbowL', 'elbowR')] },
      { name: 'Trunk',      metrics: [offLevel('pelvisTilt'), offLevel('shoulderTilt')] },
      // Lower symmetry is scored from the Symmetry Index of the reliable hip and
      // knee joints at peak flexion (ankle excluded — foot-index too noisy).
      { name: 'Lower Body', siJoints: [['hipL', 'hipR'], ['kneeL', 'kneeR']] },
    ],
    vertical: [
      { name: 'Upper Body', indices: [11, 12, 13, 14, 15, 16] }, // shoulders, elbows, wrists
      { name: 'Trunk',      indices: [11, 12, 23, 24] },         // shoulders, hips
      { name: 'Lower Body', indices: [23, 24, 25, 26, 27, 28] }, // hips, knees, ankles
    ],
  },
}

// ── Scoring maps (tunable) ────────────────────────────────────────

// Average L/R angular difference (deg) that maps to a symmetry score of 0.
const SYM_FLOOR = 45
// Symmetry Index (%) at peak flexion that maps to a Lower-body score of 0.
const SI_FLOOR = 20
// ABSOLUTE vertical alignment: total horizontal drift (metres) that maps to 0.
const DRIFT_FLOOR_ABS = 0.30
// RELATIVE vertical alignment: excess drift over the reference (metres) → 0.
const DRIFT_FLOOR = 0.12

function clamp100(s) { return Math.max(0, Math.min(100, Math.round(s))) }

// Symmetry from a per-frame-averaged L/R discrepancy (degrees). In 'relative'
// mode the reference's own discrepancy is subtracted first, so a trial as
// symmetric as the gold standard scores 100.
function symScore(userDev, refDev, mode) {
  const dev = mode === 'relative' ? Math.max(0, userDev - refDev) : userDev
  return clamp100(100 - dev * (100 / SYM_FLOOR))
}

// Lower-body symmetry from Symmetry Index (%). 'relative' subtracts the
// reference's own SI so a trial as symmetric as the gold standard scores 100.
function siScore(userSI, refSI, mode) {
  const si = mode === 'relative' ? Math.max(0, userSI - refSI) : userSI
  return clamp100(100 - si * (100 / SI_FLOOR))
}

// Vertical alignment from horizontal drift (metres). 'absolute' scores against
// zero drift; 'relative' scores against the reference's drift (reference = 100).
function vertScore(userDrift, refDrift, mode) {
  return mode === 'relative'
    ? clamp100(100 - Math.max(0, userDrift - refDrift) * (100 / DRIFT_FLOOR))
    : clamp100(100 - userDrift * (100 / DRIFT_FLOOR_ABS))
}

function meanScore(sections) {
  return Math.round(sections.reduce((s, x) => s + x.score, 0) / sections.length)
}

// Mean over all frames of a section's per-frame metric values (degrees).
function avgMetrics(frames, metrics) {
  let sum = 0, cnt = 0
  for (const L of frames) for (const metric of metrics) { sum += metric(L); cnt++ }
  return cnt ? sum / cnt : 0
}

// RMS horizontal (x–z plane) distance of each section marker from its own mean
// position across the movement, averaged over the section's markers. World
// landmarks are hip-centred, so this captures sway relative to the body centre.
function sectionDrift(frames, indices) {
  let sum = 0
  const n = frames.length
  for (const idx of indices) {
    let mx = 0, mz = 0
    for (const L of frames) { mx += L[idx].x; mz += L[idx].z }
    mx /= n; mz /= n
    let v = 0
    for (const L of frames) { v += (L[idx].x - mx) ** 2 + (L[idx].z - mz) ** 2 }
    sum += Math.sqrt(v / n)
  }
  return sum / indices.length
}

// ── Squat phase detection & symmetry diagnostics ──────────────────

// Bottom of the squat = frame of peak knee flexion (smallest hip–knee–ankle
// angle). Rotation-invariant, so it works from any camera view. The search is
// restricted to the interior (first/last ~10% of frames excluded) so a rep
// truncated at the clip edge can't be chosen, guaranteeing non-degenerate
// descent/ascent windows. (For multi-rep trials the phases span from the clip
// start/end to this deepest interior bottom rather than a single rep.)
function detectSquatPhases(frames) {
  const n = frames.length
  const margin = Math.max(3, Math.round(n * 0.1))
  let bottomIdx = Math.min(margin, n - 1), minAngle = Infinity
  for (let i = margin; i < n - margin; i++) {
    const kneeMean = (FEATURES.kneeL(frames[i]) + FEATURES.kneeR(frames[i])) / 2
    if (kneeMean < minAngle) { minAngle = kneeMean; bottomIdx = i }
  }
  return { bottomIdx, descent: [0, bottomIdx], ascent: [bottomIdx, n - 1] }
}

// SI at the peak-flexion frame for a hip+knee pair set — the value that feeds
// the Lower-body symmetry score. Averaged across the supplied joint pairs.
function bottomSI(frames, bottomIdx, pairs) {
  const L = frames[bottomIdx]
  let sum = 0
  for (const [a, b] of pairs) sum += symmetryIndex(FEATURES[a](L), FEATURES[b](L))
  return sum / pairs.length
}

const DIAG_JOINTS = [
  { name: 'Hip',   l: 'hipL',   r: 'hipR' },
  { name: 'Knee',  l: 'kneeL',  r: 'kneeR' },
  { name: 'Ankle', l: 'ankleL', r: 'ankleR', lowConfidence: true },
]

// Mean SI and SA over an inclusive frame range [i0, i1].
function phaseSymmetry(frames, l, r, [i0, i1]) {
  let si = 0, sa = 0, n = 0
  for (let i = i0; i <= i1; i++) {
    const L = frames[i]
    const lv = FEATURES[l](L), rv = FEATURES[r](L)
    si += symmetryIndex(lv, rv); sa += symmetryAngle(lv, rv); n++
  }
  return n ? { si: si / n, sa: sa / n } : { si: 0, sa: 0 }
}

// Peak absolute trunk deviation (cm) over an inclusive frame range.
function phaseTrunkPeak(frames, [i0, i1]) {
  let peak = 0
  for (let i = i0; i <= i1; i++) peak = Math.max(peak, Math.abs(trunkDeviation(frames[i])))
  return peak * 100
}

// Per-joint SI/SA across Descent / Bottom / Ascent, plus trunk deviation.
// SI/SA are absolute asymmetry measures, reported independently of score mode.
function squatDiagnostics(frames) {
  const { bottomIdx, descent, ascent } = detectSquatPhases(frames)
  const bottomL = frames[bottomIdx]

  const joints = DIAG_JOINTS.map(j => ({
    name: j.name,
    lowConfidence: !!j.lowConfidence,
    bottom:  { si: symmetryIndex(FEATURES[j.l](bottomL), FEATURES[j.r](bottomL)),
               sa: symmetryAngle(FEATURES[j.l](bottomL), FEATURES[j.r](bottomL)) },
    descent: phaseSymmetry(frames, j.l, j.r, descent),
    ascent:  phaseSymmetry(frames, j.l, j.r, ascent),
  }))

  const trunk = {
    bottomCm:      trunkDeviation(bottomL) * 100,
    descentPeakCm: phaseTrunkPeak(frames, descent),
    ascentPeakCm:  phaseTrunkPeak(frames, ascent),
  }

  return { bottomIdx, joints, trunk }
}

// ── Public API ────────────────────────────────────────────────────
//
// userFrames: [{worldLandmarks: [{x,y,z} x33]}] — a recorded trial
// refData:    reference landmark JSON ({frames: [{t, wlm: [[x,y,z,v] x33]}]})
// testId:     an FMS test id
//
// mode: 'absolute' (perfect symmetry / zero drift = 100) or 'relative' (the
//       gold-standard reference = 100, even if it isn't perfect).
//
// Returns null when the test has no geometric config or inputs are unusable,
// else: { mode, symmetry: { score, sections: [{name, score}] },
//         vertical: { score, sections: [{name, score}] },
//         diagnostics: {bottomIdx, joints, trunk} | null }

export function scoreGeometric(userFrames, refData, testId, mode = 'relative') {
  const config = GEO_TESTS[testId]
  if (!config || userFrames.length < 10 || !refData?.frames?.length) return null

  const userLm = userFrames.map(f => f.worldLandmarks)
  const refLm  = refData.frames.map(f => f.wlm.map(([x, y, z]) => ({ x, y, z })))

  const userBottom = detectSquatPhases(userLm).bottomIdx
  const refBottom  = detectSquatPhases(refLm).bottomIdx

  // Horizontal Symmetry — angular-discrepancy sections, or SI-based sections
  // (siJoints) scored from the Symmetry Index at peak flexion.
  const symSections = config.symmetry.map(sec => {
    if (sec.siJoints) {
      const userSI = bottomSI(userLm, userBottom, sec.siJoints)
      const refSI  = bottomSI(refLm,  refBottom,  sec.siJoints)
      return { name: sec.name, score: siScore(userSI, refSI, mode) }
    }
    const userDev = avgMetrics(userLm, sec.metrics)
    const refDev  = avgMetrics(refLm,  sec.metrics)
    return { name: sec.name, score: symScore(userDev, refDev, mode) }
  })

  // Vertical Alignment — horizontal drift, absolute or relative to the reference.
  const vertSections = config.vertical.map(sec => {
    const userDrift = sectionDrift(userLm, sec.indices)
    const refDrift  = sectionDrift(refLm,  sec.indices)
    return { name: sec.name, score: vertScore(userDrift, refDrift, mode) }
  })

  return {
    mode,
    symmetry: { sections: symSections, score: meanScore(symSections) },
    vertical: { sections: vertSections, score: meanScore(vertSections) },
    diagnostics: config.diagnostics ? squatDiagnostics(userLm) : null,
  }
}
