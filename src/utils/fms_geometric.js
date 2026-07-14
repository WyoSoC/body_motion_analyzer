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

// ── Per-test configuration ────────────────────────────────────────
// symmetry sections: metrics = angle-discrepancy functions (deg per frame)
// vertical sections: indices = landmark indices whose horizontal drift is scored
export const GEO_TESTS = {
  'deep-squat': {
    symmetry: [
      { name: 'Upper Body', metrics: [pairDiff('shoulderL', 'shoulderR'), pairDiff('elbowL', 'elbowR')] },
      { name: 'Trunk',      metrics: [offLevel('pelvisTilt'), offLevel('shoulderTilt')] },
      // Ankle angle (via foot-index landmarks) is too noisy to reflect real
      // asymmetry, so Lower symmetry uses the reliable knee and hip joints only.
      { name: 'Lower Body', metrics: [pairDiff('kneeL', 'kneeR'), pairDiff('hipL', 'hipR')] },
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
//         vertical: { score, sections: [{name, score}] } }

export function scoreGeometric(userFrames, refData, testId, mode = 'relative') {
  const config = GEO_TESTS[testId]
  if (!config || userFrames.length < 10 || !refData?.frames?.length) return null

  const userLm = userFrames.map(f => f.worldLandmarks)
  const refLm  = refData.frames.map(f => f.wlm.map(([x, y, z]) => ({ x, y, z })))

  // Horizontal Symmetry — absolute L/R discrepancy, or relative to the reference's.
  const symSections = config.symmetry.map(sec => {
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
  }
}
