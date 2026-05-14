// ── Signal utilities ──────────────────────────────────────────

function diff(arr) {
  return arr.slice(1).map((v, i) => v - arr[i])
}

function mean(arr) {
  return arr.reduce((s, v) => s + v, 0) / arr.length
}

function std(arr) {
  const m = mean(arr)
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length)
}

function trapz(y, x) {
  let sum = 0
  for (let i = 1; i < y.length; i++) {
    sum += 0.5 * (y[i] + y[i - 1]) * (x[i] - x[i - 1])
  }
  return sum
}

// ── Position helpers ──────────────────────────────────────────

// Returns [{t, x, y, z}] for a single landmark index across all frames.
// useWorld=true  → reads frame.worldLandmarks (meters, body-centered; Pose & Hands only)
// useWorld=false → reads frame.landmarks (normalized [0,1]), scales x/y/z by pxPerMm if provided
export function extractLandmarkTimeSeries(landmarkData, lmIndex, pxPerMm = null, useWorld = false) {
  return landmarkData
    .filter(f => useWorld
      ? f.worldLandmarks?.[lmIndex] != null
      : f.landmarks?.[lmIndex] != null)
    .map(f => {
      if (useWorld) {
        const lm = f.worldLandmarks[lmIndex]
        return { t: f.timestamp / 1000, x: lm.x, y: lm.y, z: lm.z }
      }
      const lm    = f.landmarks[lmIndex]
      const scale = pxPerMm ?? 1
      return { t: f.timestamp / 1000, x: lm.x * scale, y: lm.y * scale, z: lm.z * scale }
    })
}

// Centroid of a group of landmarks per frame, with optional z.
// useWorld=true  → uses frame.worldLandmarks (meters)
// useWorld=false → uses frame.landmarks (normalized), scaled by pxPerMm
export function extractGroupTimeSeries(landmarkData, indices, pxPerMm = null, useWorld = false) {
  return landmarkData
    .filter(f => useWorld ? f.worldLandmarks?.length : f.landmarks?.length)
    .map(f => {
      if (useWorld) {
        const valid = indices.filter(i => f.worldLandmarks?.[i] != null)
        if (!valid.length) return null
        const x = valid.reduce((s, i) => s + f.worldLandmarks[i].x, 0) / valid.length
        const y = valid.reduce((s, i) => s + f.worldLandmarks[i].y, 0) / valid.length
        const z = valid.reduce((s, i) => s + f.worldLandmarks[i].z, 0) / valid.length
        return { t: f.timestamp / 1000, x, y, z }
      }
      const scale = pxPerMm ?? 1
      const valid = indices.filter(i => f.landmarks?.[i] != null)
      if (!valid.length) return null
      const x = valid.reduce((s, i) => s + f.landmarks[i].x, 0) / valid.length * scale
      const y = valid.reduce((s, i) => s + f.landmarks[i].y, 0) / valid.length * scale
      const z = valid.reduce((s, i) => s + f.landmarks[i].z, 0) / valid.length * scale
      return { t: f.timestamp / 1000, x, y, z }
    })
    .filter(Boolean)
}

// ── Core metrics ──────────────────────────────────────────────

// 3D speed: Euclidean distance in x/y/z per second.
// z defaults to 0 for series without a z field (graceful 2D→3D upgrade).
export function computeSpeed(series) {
  if (series.length < 2) return { times: [], values: [] }
  const times = [], values = []
  for (let i = 1; i < series.length; i++) {
    const dt = series[i].t - series[i - 1].t
    if (dt <= 0) continue
    const dx = series[i].x - series[i - 1].x
    const dy = series[i].y - series[i - 1].y
    const dz = (series[i].z ?? 0) - (series[i - 1].z ?? 0)
    times.push((series[i].t + series[i - 1].t) / 2)
    values.push(Math.sqrt(dx * dx + dy * dy + dz * dz) / dt)
  }
  return { times, values }
}

export function computeAcceleration(series) {
  const speed = computeSpeed(series)
  if (speed.times.length < 2) return { times: [], values: [] }
  const times = [], values = []
  for (let i = 1; i < speed.times.length; i++) {
    const dt = speed.times[i] - speed.times[i - 1]
    if (dt <= 0) continue
    times.push((speed.times[i] + speed.times[i - 1]) / 2)
    values.push((speed.values[i] - speed.values[i - 1]) / dt)
  }
  return { times, values }
}

export function computeJerk(series) {
  const accel = computeAcceleration(series)
  if (accel.times.length < 2) return { times: [], values: [] }
  const times = [], values = []
  for (let i = 1; i < accel.times.length; i++) {
    const dt = accel.times[i] - accel.times[i - 1]
    if (dt <= 0) continue
    times.push((accel.times[i] + accel.times[i - 1]) / 2)
    values.push((accel.values[i] - accel.values[i - 1]) / dt)
  }
  return { times, values }
}

// Normalized jerk (log scale, dimensionless).
// Ref: Teulings et al. 1997 / Hogan 1984.
// Cascades from computeJerk → automatically 3D when series has z.
export function computeNormalizedJerk(series) {
  const jerk = computeJerk(series)
  if (jerk.times.length < 2) return null
  const T = series[series.length - 1].t - series[0].t
  if (T <= 0) return null

  const speed = computeSpeed(series)
  const vMax = Math.max(...speed.values)
  if (vMax <= 0) return null

  const j2 = jerk.values.map(j => j * j)
  const integralJ2 = trapz(j2, jerk.times)
  const nj = Math.sqrt(0.5 * (T ** 5 / vMax ** 2) * integralJ2)
  return isFinite(nj) ? Math.log(nj) : null
}

// Sample Entropy — complexity measure.
export function computeSampleEntropy(values, m = 2, r = 0.2) {
  const N = values.length
  if (N < m + 2) return null
  const tolerance = r * std(values)
  if (tolerance === 0) return null

  function countMatches(len) {
    let count = 0
    for (let i = 0; i < N - len; i++) {
      for (let j = i + 1; j < N - len; j++) {
        let match = true
        for (let k = 0; k < len; k++) {
          if (Math.abs(values[i + k] - values[j + k]) > tolerance) { match = false; break }
        }
        if (match) count++
      }
    }
    return count
  }

  const B = countMatches(m)
  const A = countMatches(m + 1)
  if (B === 0 || A === 0) return null
  return -Math.log(A / B)
}

// 3D Range of motion: per-axis excursion + 3D resultant.
export function computeROM(series) {
  if (!series.length) return { x: 0, y: 0, z: 0, resultant: 0 }
  const xs = series.map(p => p.x)
  const ys = series.map(p => p.y)
  const zs = series.map(p => p.z ?? 0)
  const romX = Math.max(...xs) - Math.min(...xs)
  const romY = Math.max(...ys) - Math.min(...ys)
  const romZ = Math.max(...zs) - Math.min(...zs)
  return { x: romX, y: romY, z: romZ, resultant: Math.sqrt(romX ** 2 + romY ** 2 + romZ ** 2) }
}

// Summary statistics for a value array.
export function summarize(values) {
  if (!values.length) return {}
  const sorted = [...values].sort((a, b) => a - b)
  const m = mean(values)
  const s = std(values)
  return {
    mean: m,
    std: s,
    cv: s / Math.abs(m),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    median: sorted[Math.floor(sorted.length / 2)],
    p25: sorted[Math.floor(sorted.length * 0.25)],
    p75: sorted[Math.floor(sorted.length * 0.75)],
  }
}

export const METRIC_DEFS = [
  { key: 'speed',       label: 'Speed',            color: '#5b7fff', unit: '/s' },
  { key: 'accel',       label: 'Acceleration',     color: '#3ecf70', unit: '/s²' },
  { key: 'jerk',        label: 'Jerk',             color: '#f59e0b', unit: '/s³' },
  { key: 'normjerk',    label: 'Normalized Jerk',  color: '#ef4444', unit: '(scalar)' },
  { key: 'sampentropy', label: 'Sample Entropy',   color: '#8b5cf6', unit: '(bits)' },
  { key: 'rom',         label: 'Range of Motion',  color: '#06b6d4', unit: 'units' },
]

export function computeAllMetrics(series) {
  const speed = computeSpeed(series)
  const accel = computeAcceleration(series)
  const jerk  = computeJerk(series)
  const nj    = computeNormalizedJerk(series)
  const se    = computeSampleEntropy(speed.values)
  const rom   = computeROM(series)

  return { speed, accel, jerk, normjerk: nj, sampentropy: se, rom }
}
