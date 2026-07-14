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
// Excess horizontal drift over the reference (metres) that maps to a
// vertical-alignment score of 0.
const DRIFT_FLOOR = 0.12

function clamp100(s) { return Math.max(0, Math.min(100, Math.round(s))) }

function symScore(devDeg) {
  return clamp100(100 - devDeg * (100 / SYM_FLOOR))
}

function vertScore(userDrift, refDrift) {
  return clamp100(100 - Math.max(0, userDrift - refDrift) * (100 / DRIFT_FLOOR))
}

function meanScore(sections) {
  return Math.round(sections.reduce((s, x) => s + x.score, 0) / sections.length)
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
// Returns null when the test has no geometric config or inputs are unusable,
// else: { symmetry: { score, sections: [{name, score}] },
//         vertical: { score, sections: [{name, score}] } }

export function scoreGeometric(userFrames, refData, testId) {
  const config = GEO_TESTS[testId]
  if (!config || userFrames.length < 10 || !refData?.frames?.length) return null

  const userLm = userFrames.map(f => f.worldLandmarks)
  const refLm  = refData.frames.map(f => f.wlm.map(([x, y, z]) => ({ x, y, z })))

  // Horizontal Symmetry — user only, absolute L/R discrepancy.
  const symSections = config.symmetry.map(sec => {
    let sum = 0, cnt = 0
    for (const L of userLm) for (const metric of sec.metrics) { sum += metric(L); cnt++ }
    return { name: sec.name, score: symScore(cnt ? sum / cnt : 0) }
  })

  // Vertical Alignment — horizontal drift vs the gold-standard reference.
  const vertSections = config.vertical.map(sec => {
    const userDrift = sectionDrift(userLm, sec.indices)
    const refDrift  = sectionDrift(refLm,  sec.indices)
    return { name: sec.name, score: vertScore(userDrift, refDrift) }
  })

  return {
    symmetry: { sections: symSections, score: meanScore(symSections) },
    vertical: { sections: vertSections, score: meanScore(vertSections) },
  }
}
