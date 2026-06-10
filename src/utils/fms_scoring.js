// FMS scoring engine — Deep Squat and Hurdle Step.
//
// Input:  worldLandmarks — 33-element array of {x,y,z} in meters,
//         body-centered at the mid-hip origin (MediaPipe convention).
//         Coordinate convention: y increases DOWNWARD, z toward camera.
//
// Output: { total: 0-100, fmsEquiv: 0-3, criteria: [{name, score, detail, weight}] }
//
// Score bands intentionally mirror FMS ordinal thresholds:
//   67-100  ↔  FMS 3 (full movement, no compensation)
//   34-66   ↔  FMS 2 (compensated movement)
//   1-33    ↔  FMS 1 (unable to complete)
//   0       ↔  FMS 0 (pain — not assessed here)

// ── Geometry helpers ──────────────────────────────────────────

function mid(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 }
}

function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }
}

function dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z }

function mag(v) { return Math.sqrt(v.x ** 2 + v.y ** 2 + v.z ** 2) }

function norm(v) {
  const m = mag(v)
  return m < 1e-6 ? { x: 0, y: 0, z: 0 } : { x: v.x / m, y: v.y / m, z: v.z / m }
}

// Angle (degrees) at vertex p2, formed by the ray p1→p2 and the ray p3→p2.
export function angle3pt(p1, p2, p3) {
  const v1 = norm(sub(p1, p2))
  const v2 = norm(sub(p3, p2))
  return Math.acos(Math.max(-1, Math.min(1, dot(v1, v2)))) * 180 / Math.PI
}

// Angle (degrees) between two free vectors.
function angleBetween(v1, v2) {
  return Math.acos(Math.max(-1, Math.min(1, dot(norm(v1), norm(v2))))) * 180 / Math.PI
}

function clamp100(x) { return Math.max(0, Math.min(100, x)) }

// Map x linearly from [lo, hi] → [0, 100].
function remap(x, lo, hi) { return clamp100((x - lo) / (hi - lo) * 100) }

// Map a score to an FMS ordinal.
export function toFMS(score100) {
  if (score100 >= 67) return 3
  if (score100 >= 34) return 2
  if (score100 >= 1)  return 1
  return 0
}

// Score → CSS color string.
export function scoreColor(s) {
  return s >= 67 ? '#3ecf70' : s >= 34 ? '#f59e0b' : '#ef4444'
}

// ── Deep Squat ────────────────────────────────────────────────
//
// Camera placement: any view works — world landmarks provide 3-D positions.
// Best results with a ~45° (between frontal and sagittal) or pure sagittal view.
//
// Criteria and weights:
//   C1 Hip Depth            35%  — femur below horizontal (hip below knee)
//   C2 Trunk-Tibia Angle    30%  — upper torso parallel with tibia
//   C3 Knee Alignment       25%  — knees track over feet (no valgus/varus)
//   C4 Overhead Alignment   10%  — arms/wrists overhead (dowel proxy)
//
// Thresholds calibrated against the biomechanics literature:
//   Hip depth:   avg_knee.y in world coords (hip-centered, y-down).
//                +0.20 m → 0 pts  (hip well above knee, FMS 1)
//                 0.00 m → 67 pts (hip at knee level, FMS 2-3 boundary)
//                -0.10 m → 100 pts (hip clearly below knee, FMS 3)
//
//   Trunk-tibia: angle between trunk and tibia vectors.
//                ≤10° → FMS 3 territory;  >25° → FMS 1 territory.
//
//   Knee alignment: deviation of knee from hip-ankle interpolation line (m).
//                0 → 100 pts;  0.15 m → 0 pts.

export function scoreDeepSquat(wlm) {
  const L = wlm   // shorthand

  // Key landmarks
  const lSh  = L[11], rSh  = L[12]
  const lHip = L[23], rHip = L[24]
  const lKne = L[25], rKne = L[26]
  const lAnk = L[27], rAnk = L[28]
  const lWri = L[15], rWri = L[16]

  const midSh  = mid(lSh,  rSh)
  const midHip = mid(lHip, rHip)
  const midKne = mid(lKne, rKne)
  const midAnk = mid(lAnk, rAnk)
  const midWri = mid(lWri, rWri)

  // ── C1: Hip depth (femur below horizontal) ──────────────────
  // In world coords (hip = origin, y increases downward):
  //   Standing:  knee.y ≈ +0.40 m  (knee is below hip)
  //   Deep squat: knee.y decreases → 0 or negative (hip sinks below knees)
  const avgKneeY = (lKne.y + rKne.y) / 2
  // +0.20 → 0,  0.00 → 67,  -0.10 → 100
  const hipDepthScore = clamp100((0.20 - avgKneeY) / 0.30 * 100)

  // ── C2: Trunk-tibia parallelism ─────────────────────────────
  // Both vectors point "upward" (negative-y direction from distal to proximal).
  const trunkVec = sub(midSh,  midHip)   // hip → shoulder
  const tibiaVec = sub(midKne, midAnk)   // ankle → knee
  const trunkTibiaAngle = angleBetween(trunkVec, tibiaVec)
  // 0° → 100,  10° → ~60,  25° → 0
  const trunkTibiaScore = clamp100(100 - trunkTibiaAngle * 4)

  // ── C3: Knee alignment (frontal plane) ──────────────────────
  // Expected knee X = linear interpolation between hip and ankle at knee depth.
  const lExpX = lHip.x + (lAnk.x - lHip.x) * (lKne.y - lHip.y) / (lAnk.y - lHip.y + 1e-4)
  const rExpX = rHip.x + (rAnk.x - rHip.x) * (rKne.y - rHip.y) / (rAnk.y - rHip.y + 1e-4)
  const maxKneeDev = Math.max(Math.abs(lKne.x - lExpX), Math.abs(rKne.x - rExpX))
  // 0 m → 100,  0.05 m → 67,  0.15 m → 0
  const kneeAlignScore = clamp100(100 - maxKneeDev * 667)

  // ── C4: Overhead (arms raised, wrists above shoulders) ─────
  // midWrist.y < midShoulder.y means wrists are above shoulders (good).
  // armsRaised > 0 → overhead; typical max ~0.35 m above shoulders.
  const armsRaised = midSh.y - midWri.y   // positive when wrists above shoulders
  // -0.10 m → 0,  0.00 m → 25,  0.30 m → 100
  const armScore = remap(armsRaised, -0.10, 0.30)

  // ── Weighted total ───────────────────────────────────────────
  const total = Math.round(
    hipDepthScore   * 0.35 +
    trunkTibiaScore * 0.30 +
    kneeAlignScore  * 0.25 +
    armScore        * 0.10
  )

  return {
    total,
    fmsEquiv: toFMS(total),
    criteria: [
      {
        name: 'Hip Depth',
        score: Math.round(hipDepthScore),
        detail: `Knee rel. hip: ${(avgKneeY * 100).toFixed(1)} cm`,
        weight: 0.35,
        description: 'Femur below horizontal — hip sinks to or below knee level',
      },
      {
        name: 'Trunk–Tibia Angle',
        score: Math.round(trunkTibiaScore),
        detail: `${trunkTibiaAngle.toFixed(1)}°`,
        weight: 0.30,
        description: 'Upper torso parallel with tibia (target < 10°)',
      },
      {
        name: 'Knee Alignment',
        score: Math.round(kneeAlignScore),
        detail: `Max dev: ${(maxKneeDev * 100).toFixed(1)} cm`,
        weight: 0.25,
        description: 'Knees track over feet — no valgus/varus collapse',
      },
      {
        name: 'Overhead Alignment',
        score: Math.round(armScore),
        detail: `Arms ${armsRaised > 0 ? '+' : ''}${(armsRaised * 100).toFixed(0)} cm`,
        weight: 0.10,
        description: 'Wrists overhead, dowel not extending past feet',
      },
    ],
  }
}

// ── Hurdle Step ───────────────────────────────────────────────
//
// steppingLeg: 'left' | 'right' — the leg that steps over the hurdle.
// Camera: sagittal (side) view gives best data, but frontal also works.
//
// Criteria and weights:
//   C1 Step Height              35%  — stepping foot clears tibial tuberosity height
//   C2 Pelvic / Trunk Stability 30%  — pelvis and shoulder girdle remain level
//   C3 Stepping Leg Alignment   20%  — hip-knee-ankle alignment of stepping leg
//   C4 Foot Dorsiflexion        15%  — stepping foot hooked (dorsiflexed) during clearance
//
// Hurdle height is set to the tibial tuberosity of the standing leg
// (~25 % of the way from knee to ankle, from the knee).

export function scoreHurdleStep(wlm, steppingLeg = 'left') {
  const L = wlm

  // Landmark index helpers
  const S = steppingLeg === 'left'
    ? { sh: 11, hip: 23, kne: 25, ank: 27, heel: 29, foot: 31 }
    : { sh: 12, hip: 24, kne: 26, ank: 28, heel: 30, foot: 32 }

  const T = steppingLeg === 'left'   // standing leg
    ? { sh: 12, hip: 24, kne: 26, ank: 28, heel: 30, foot: 32 }
    : { sh: 11, hip: 23, kne: 25, ank: 27, heel: 29, foot: 31 }

  const lSh  = L[11], rSh  = L[12]
  const lHip = L[23], rHip = L[24]

  const stSh  = L[S.sh],  stHip = L[S.hip], stKne = L[S.kne]
  const stAnk = L[S.ank], stFoot = L[S.foot]
  const tnKne = L[T.kne], tnAnk = L[T.ank]

  // ── C1: Step height ──────────────────────────────────────────
  // Tibial tuberosity of standing leg: 25 % from knee toward ankle.
  const tibTubY = tnKne.y + 0.25 * (tnAnk.y - tnKne.y)
  // Clearance: tibTubY - stepping_foot.y
  //   > 0 → foot above hurdle height (good)
  //   < 0 → foot below hurdle height (contacts hurdle)
  const clearance = tibTubY - stFoot.y
  // -0.05 m → 0,  0.00 m → 71,  +0.05 m → 100
  const stepHeightScore = remap(clearance, -0.05, 0.05)

  // ── C2: Pelvic / Trunk Stability ─────────────────────────────
  // Lateral tilt: difference in Y between left and right hips (and shoulders).
  // In world coords, hips should be level → same Y value.
  const pelvisLateral  = Math.abs(lHip.y - rHip.y)
  const shoulderLateral = Math.abs(lSh.y  - rSh.y)
  const maxLateral = Math.max(pelvisLateral, shoulderLateral)
  // 0 m → 100,  0.03 m → 67,  0.06 m → 0
  const stabilityScore = clamp100(100 - maxLateral * 1667)

  // ── C3: Stepping leg alignment ───────────────────────────────
  // Hip, knee and ankle of the stepping leg should stay in the sagittal plane —
  // minimal deviation in the frontal (X) direction.
  const expKneX = stHip.x + (stAnk.x - stHip.x) * (stKne.y - stHip.y) / (stAnk.y - stHip.y + 1e-4)
  const kneeDev = Math.abs(stKne.x - expKneX)
  // 0 m → 100,  0.05 m → 67,  0.15 m → 0
  const alignmentScore = clamp100(100 - kneeDev * 667)

  // ── C4: Foot dorsiflexion ─────────────────────────────────────
  // Angle at ankle: knee → ankle → foot_index.
  // y-down convention: knee is above ankle → knee.y < ankle.y.
  // Dorsiflexion: foot_index moves toward shin → angle decreases from ~90°.
  // Small angle = dorsiflexed (good), large angle = plantarflexed.
  const dorsAngle = angle3pt(stKne, stAnk, stFoot)
  // 50° → 100 (fully hooked),  90° → 33 (neutral),  120° → 0 (pointed)
  const dorsScore = remap(dorsAngle, 120, 50)

  // ── Weighted total ───────────────────────────────────────────
  const total = Math.round(
    stepHeightScore * 0.35 +
    stabilityScore  * 0.30 +
    alignmentScore  * 0.20 +
    dorsScore       * 0.15
  )

  const midHip = mid(lHip, rHip)
  const midSh  = mid(lSh,  rSh)

  return {
    total,
    fmsEquiv: toFMS(total),
    criteria: [
      {
        name: 'Step Height',
        score: Math.round(stepHeightScore),
        detail: `Clearance: ${(clearance * 100).toFixed(1)} cm`,
        weight: 0.35,
        description: 'Stepping foot clears tibial tuberosity height',
      },
      {
        name: 'Trunk Stability',
        score: Math.round(stabilityScore),
        detail: `Lateral: ${(maxLateral * 100).toFixed(1)} cm`,
        weight: 0.30,
        description: 'Pelvis & shoulders remain level — no lateral sway',
      },
      {
        name: 'Leg Alignment',
        score: Math.round(alignmentScore),
        detail: `Knee dev: ${(kneeDev * 100).toFixed(1)} cm`,
        weight: 0.20,
        description: 'Hip-knee-ankle track in the sagittal plane',
      },
      {
        name: 'Foot Dorsiflexion',
        score: Math.round(dorsScore),
        detail: `Ankle angle: ${dorsAngle.toFixed(1)}°`,
        weight: 0.15,
        description: 'Stepping foot dorsiflexed (hooked up) during clearance',
      },
    ],
  }
}

// ── Phase detection ───────────────────────────────────────────
//
// Maintains a rolling buffer of the metric that indicates movement depth.
// For deep squat: avg knee Y (world).  For hurdle step: stepping knee Y.
// Returns: 'standing' | 'descending' | 'bottom' | 'ascending' | 'peak'

const BUFFER_SIZE = 30   // ~1 s at 30 fps

export class PhaseDetector {
  constructor(test) {
    this.test    = test    // 'deep-squat' | 'hurdle-step'
    this.buffer  = []
    this.peaked  = false
    this.baseline = null
  }

  reset() { this.buffer = []; this.peaked = false; this.baseline = null }

  // Returns { phase, metric }
  update(wlm, steppingLeg = 'left') {
    let metric
    if (this.test === 'deep-squat') {
      // avg knee Y; decreases as hips descend (femur rises relative to hip origin)
      metric = (wlm[25].y + wlm[26].y) / 2
    } else {
      // stepping knee Y; decreases as knee rises during the step
      const kIdx = steppingLeg === 'left' ? 25 : 26
      metric = wlm[kIdx].y
    }

    this.buffer.push(metric)
    if (this.buffer.length > BUFFER_SIZE) this.buffer.shift()
    if (this.buffer.length < 10) return { phase: 'waiting', metric }

    // Set baseline to the first reading (assumed to be standing)
    if (this.baseline === null) this.baseline = metric

    const n  = this.buffer.length
    const recent = this.buffer.slice(-5).reduce((a, b) => a + b, 0) / 5
    const prev   = this.buffer.slice(-15, -5).reduce((a, b) => a + b, 0) /
                   Math.min(10, Math.max(1, n - 5))

    // How far from baseline (standing) have we moved?
    const depth = this.baseline - recent   // positive when moved from baseline

    let phase
    if (depth < 0.04) {
      phase = 'standing'
      this.baseline = recent  // recalibrate while standing
    } else if (recent < prev - 0.01) {
      phase = this.test === 'deep-squat' ? 'descending' : 'lifting'
    } else if (recent > prev + 0.01 && depth > 0.04) {
      phase = this.test === 'deep-squat' ? 'ascending' : 'returning'
    } else {
      phase = this.test === 'deep-squat' ? 'bottom' : 'peak'
    }

    return { phase, metric }
  }
}
