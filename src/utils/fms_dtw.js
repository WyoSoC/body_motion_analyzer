// DTW-based FMS scoring — grades a user trial against the gold-standard
// reference performance (100 points) for all 7 FMS movement tests.
//
// Method:
//   1. Convert both the user trial and the reference into per-frame joint-angle
//      feature vectors (view- and body-size-invariant).
//   2. Align the two sequences with Dynamic Time Warping (handles different
//      movement speeds and rep timing).
//   3. Score = 100 minus the average per-frame angular deviation along the
//      alignment path, scaled so DEV_FLOOR degrees → 0 points.
//
// Mirroring: the trial is scored in both normal and left/right-swapped
// orientation and the better one wins, so the user may lead with either leg.

// Map a 0–100 score to a red/amber/green UI color (FMS 1/2/3 bands).
export function scoreColor(s) {
  return s >= 67 ? '#3ecf70' : s >= 34 ? '#f59e0b' : '#ef4444'
}

// ── Geometry ──────────────────────────────────────────────────

export function angleDeg(a, b, c) {
  const v1 = { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }
  const v2 = { x: c.x - b.x, y: c.y - b.y, z: c.z - b.z }
  const dot = v1.x * v2.x + v1.y * v2.y + v1.z * v2.z
  const m = Math.sqrt((v1.x ** 2 + v1.y ** 2 + v1.z ** 2) * (v2.x ** 2 + v2.y ** 2 + v2.z ** 2))
  return Math.acos(Math.max(-1, Math.min(1, dot / (m + 1e-9)))) * 180 / Math.PI
}

export function mid(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 }
}

// Angle of segment a→b from the vertical axis (world y points down).
function inclineDeg(a, b) {
  const v = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }
  const m = Math.sqrt(v.x ** 2 + v.y ** 2 + v.z ** 2) + 1e-9
  return Math.acos(Math.max(-1, Math.min(1, -v.y / m))) * 180 / Math.PI
}

// Tilt of the line a–b out of the horizontal plane, in degrees.
function tiltDeg(a, b) {
  const dy = Math.abs(a.y - b.y)
  const len = Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2) + 1e-9
  return Math.asin(Math.min(1, dy / len)) * 180 / Math.PI
}

// ── Feature extraction ────────────────────────────────────────
// Landmark indices: 11/12 shoulders, 13/14 elbows, 15/16 wrists,
// 23/24 hips, 25/26 knees, 27/28 ankles, 31/32 foot index.

export const FEATURES = {
  kneeL:     L => angleDeg(L[23], L[25], L[27]),
  kneeR:     L => angleDeg(L[24], L[26], L[28]),
  hipL:      L => angleDeg(L[11], L[23], L[25]),
  hipR:      L => angleDeg(L[12], L[24], L[26]),
  ankleL:    L => angleDeg(L[25], L[27], L[31]),
  ankleR:    L => angleDeg(L[26], L[28], L[32]),
  shoulderL: L => angleDeg(L[13], L[11], L[23]),
  shoulderR: L => angleDeg(L[14], L[12], L[24]),
  elbowL:    L => angleDeg(L[11], L[13], L[15]),
  elbowR:    L => angleDeg(L[12], L[14], L[16]),
  trunkIncline: L => inclineDeg(mid(L[23], L[24]), mid(L[11], L[12])),
  pelvisTilt:   L => tiltDeg(L[23], L[24]),
  shoulderTilt: L => tiltDeg(L[11], L[12]),
}

// Left/right feature swaps for mirrored scoring.
const MIRROR = {
  kneeL: 'kneeR', kneeR: 'kneeL',
  hipL: 'hipR', hipR: 'hipL',
  ankleL: 'ankleR', ankleR: 'ankleL',
  shoulderL: 'shoulderR', shoulderR: 'shoulderL',
  elbowL: 'elbowR', elbowR: 'elbowL',
}

const LOWER = ['kneeL', 'kneeR', 'hipL', 'hipR', 'ankleL', 'ankleR']
const TRUNK = ['trunkIncline', 'pelvisTilt', 'shoulderTilt']
const ARMS  = ['shoulderL', 'shoulderR', 'elbowL', 'elbowR']

// Per-test feature groups. Weights sum to 1; group scores are shown as
// criteria bars, the weighted sum is the test's total DTW score.
export const DTW_TESTS = {
  'deep-squat': {
    groups: [
      { name: 'Upper Body / Arm Position', features: ARMS,  weight: 0.25 },
      { name: 'Trunk Control',             features: TRUNK, weight: 0.30 },
      { name: 'Lower Body Trajectory',     features: LOWER, weight: 0.45 },
    ],
  },
  'hurdle-step': {
    groups: [
      { name: 'Lower Body Trajectory', features: LOWER, weight: 0.50 },
      { name: 'Trunk Control',         features: TRUNK, weight: 0.30 },
      { name: 'Arm Position',          features: ARMS,  weight: 0.20 },
    ],
  },
  'inline-lunge': {
    groups: [
      { name: 'Lower Body Trajectory', features: LOWER, weight: 0.50 },
      { name: 'Trunk Control',         features: TRUNK, weight: 0.30 },
      { name: 'Arm Position',          features: ARMS,  weight: 0.20 },
    ],
  },
  'shoulder-mobility': {
    groups: [
      { name: 'Arm Trajectory',  features: ARMS,  weight: 0.70 },
      { name: 'Trunk Control',   features: TRUNK, weight: 0.30 },
    ],
  },
  'active-straight-leg-raise': {
    groups: [
      { name: 'Leg Trajectory',        features: LOWER, weight: 0.60 },
      { name: 'Trunk/Pelvis Control',  features: TRUNK, weight: 0.40 },
    ],
  },
  'trunk-stability-pushup': {
    groups: [
      { name: 'Trunk Control (body line)', features: TRUNK, weight: 0.45 },
      { name: 'Arm Trajectory',            features: ARMS,  weight: 0.40 },
      { name: 'Lower Body',                features: LOWER, weight: 0.15 },
    ],
  },
  'rotary-stability': {
    groups: [
      { name: 'Lower Body Trajectory', features: LOWER, weight: 0.35 },
      { name: 'Arm Trajectory',        features: ARMS,  weight: 0.35 },
      { name: 'Trunk Control',         features: TRUNK, weight: 0.30 },
    ],
  },
}

// Average angular deviation (degrees) that maps to a score of 0.
const DEV_FLOOR = 40

function devToScore(dev) {
  return Math.max(0, Math.min(100, Math.round(100 - dev * (100 / DEV_FLOOR))))
}

// Compute the feature matrix for a landmark sequence.
// `mirrored` swaps left/right so lead-leg choice doesn't penalize the user.
function featureMatrix(frames, featureNames, mirrored) {
  return frames.map(L => featureNames.map(name => {
    const f = mirrored ? (MIRROR[name] ?? name) : name
    return FEATURES[f](L)
  }))
}

// ── DTW core ──────────────────────────────────────────────────
// Returns { dist, path } — dist is the mean per-frame feature distance along
// the optimal path; path is [[i, j], ...] pairs of (user, reference) indices.

function dtw(A, B) {
  const n = A.length, m = B.length, dim = A[0].length
  const bandRatio = m / n
  const band = Math.max(Math.round(0.25 * Math.max(n, m)), 10)

  const INF = Infinity
  // Cost of matching frame i to frame j: mean absolute angle difference.
  const cost = (i, j) => {
    let s = 0
    for (let k = 0; k < dim; k++) s += Math.abs(A[i][k] - B[j][k])
    return s / dim
  }

  // DP matrices (flat arrays for speed)
  const D = new Float64Array(n * m).fill(INF)
  const step = new Int8Array(n * m)   // 0=diag, 1=up(i-1), 2=left(j-1)

  for (let i = 0; i < n; i++) {
    const jc = i * bandRatio
    const j0 = Math.max(0, Math.floor(jc - band))
    const j1 = Math.min(m - 1, Math.ceil(jc + band))
    for (let j = j0; j <= j1; j++) {
      const c = cost(i, j)
      if (i === 0 && j === 0) { D[0] = c; continue }
      const dDiag = (i > 0 && j > 0) ? D[(i - 1) * m + j - 1] : INF
      const dUp   = (i > 0)          ? D[(i - 1) * m + j]     : INF
      const dLeft = (j > 0)          ? D[i * m + j - 1]       : INF
      const best = Math.min(dDiag, dUp, dLeft)
      if (best === INF) continue
      D[i * m + j] = c + best
      step[i * m + j] = best === dDiag ? 0 : best === dUp ? 1 : 2
    }
  }

  // Backtrack
  const path = []
  let i = n - 1, j = m - 1
  if (D[i * m + j] === INF) return null
  while (true) {
    path.push([i, j])
    if (i === 0 && j === 0) break
    const s = step[i * m + j]
    if (s === 0)      { i--; j-- }
    else if (s === 1) { i-- }
    else              { j-- }
  }
  path.reverse()
  return { dist: D[(n - 1) * m + (m - 1)] / path.length, path }
}

// ── Public API ────────────────────────────────────────────────
//
// userFrames: [{timestamp, worldLandmarks: [{x,y,z}, x33]}] — a recorded trial
// refData:    reference landmark JSON ({frames: [{t, wlm: [[x,y,z,v] x33]}]})
// testId:     one of the DTW_TESTS keys
//
// Returns null when inputs are unusable, else:
//   { total, fmsEquiv, avgDev, mirrored,
//     groups:   [{name, score, dev, weight}],
//     perFrame: [{ts, score}] }

export function scoreAgainstReference(userFrames, refData, testId) {
  const config = DTW_TESTS[testId]
  if (!config || userFrames.length < 10 || !refData?.frames?.length) return null

  const refLm  = refData.frames.map(f => f.wlm.map(([x, y, z]) => ({ x, y, z })))
  const userLm = userFrames.map(f => f.worldLandmarks)
  const allFeatures = [...new Set(config.groups.flatMap(g => g.features))]

  const refMat = featureMatrix(refLm, allFeatures, false)

  // Try both orientations, keep the better alignment.
  let best = null
  for (const mirrored of [false, true]) {
    const userMat = featureMatrix(userLm, allFeatures, mirrored)
    const r = dtw(userMat, refMat)
    if (r && (!best || r.dist < best.dist)) best = { ...r, mirrored, userMat }
  }
  if (!best) return null

  // Per-group deviation along the chosen alignment path.
  const groups = config.groups.map(g => {
    const idx = g.features.map(f => allFeatures.indexOf(f))
    let sum = 0
    for (const [i, j] of best.path) {
      for (const k of idx) sum += Math.abs(best.userMat[i][k] - refMat[j][k])
    }
    const dev = sum / (best.path.length * idx.length)
    return { name: g.name, score: devToScore(dev), dev, weight: g.weight }
  })

  const total = Math.round(groups.reduce((s, g) => s + g.score * g.weight, 0))

  // Per-frame similarity on the user's timeline (for the chart): average the
  // match cost of every reference frame aligned to each user frame.
  const frameCost = new Float64Array(userFrames.length)
  const frameCnt  = new Float64Array(userFrames.length)
  const dim = allFeatures.length
  for (const [i, j] of best.path) {
    let c = 0
    for (let k = 0; k < dim; k++) c += Math.abs(best.userMat[i][k] - refMat[j][k])
    frameCost[i] += c / dim
    frameCnt[i]++
  }
  const perFrame = userFrames.map((f, i) => ({
    ts: f.timestamp,
    score: devToScore(frameCnt[i] ? frameCost[i] / frameCnt[i] : 0),
  }))

  return {
    total,
    fmsEquiv: total >= 67 ? 3 : total >= 34 ? 2 : total >= 1 ? 1 : 0,
    avgDev: best.dist,
    mirrored: best.mirrored,
    groups,
    perFrame,
  }
}
