import { openDB } from 'idb'

const DB_NAME = 'motion-analyzer'
const DB_VERSION = 1

let _db = null

export async function getDB() {
  if (_db) return _db
  _db = await openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      // Calibration profiles
      const calStore = db.createObjectStore('calibrations', { keyPath: 'id', autoIncrement: true })
      calStore.createIndex('by-date', 'date')

      // Sessions
      const sessionStore = db.createObjectStore('sessions', { keyPath: 'id', autoIncrement: true })
      sessionStore.createIndex('by-date', 'date')

      // Trials — video blob stored separately for performance
      const trialStore = db.createObjectStore('trials', { keyPath: 'id', autoIncrement: true })
      trialStore.createIndex('by-session', 'sessionId')
      trialStore.createIndex('by-date', 'startTime')
    }
  })
  return _db
}

// ── Calibrations ──────────────────────────────────────────────

export async function saveCalibration(cal) {
  const db = await getDB()
  cal.date = Date.now()
  return db.add('calibrations', cal)
}

export async function getAllCalibrations() {
  const db = await getDB()
  return db.getAll('calibrations')
}

export async function getCalibration(id) {
  const db = await getDB()
  return db.get('calibrations', id)
}

export async function deleteCalibration(id) {
  const db = await getDB()
  return db.delete('calibrations', id)
}

// ── Sessions ──────────────────────────────────────────────────

export async function saveSession(session) {
  const db = await getDB()
  session.date = Date.now()
  return db.add('sessions', session)
}

export async function getAllSessions() {
  const db = await getDB()
  return db.getAll('sessions')
}

export async function getSession(id) {
  const db = await getDB()
  return db.get('sessions', id)
}

export async function updateSession(session) {
  const db = await getDB()
  return db.put('sessions', session)
}

export async function deleteSession(id) {
  const db = await getDB()
  // Delete all trials in session
  const trials = await getTrialsBySession(id)
  for (const t of trials) await deleteTrial(t.id)
  return db.delete('sessions', id)
}

// ── Trials ────────────────────────────────────────────────────

export async function saveTrial(trial) {
  const db = await getDB()
  return db.add('trials', trial)
}

export async function updateTrial(trial) {
  const db = await getDB()
  return db.put('trials', trial)
}

export async function getTrial(id) {
  const db = await getDB()
  return db.get('trials', id)
}

export async function getTrialsBySession(sessionId) {
  const db = await getDB()
  return db.getAllFromIndex('trials', 'by-session', sessionId)
}

export async function getAllTrials() {
  const db = await getDB()
  return db.getAll('trials')
}

export async function deleteTrial(id) {
  const db = await getDB()
  return db.delete('trials', id)
}

// ── Export helpers ────────────────────────────────────────────

export function exportTrialCSV(trial) {
  if (!trial.landmarkData?.length) return null

  const model = trial.model
  const headers = ['timestamp_ms']

  // Use the first frame that actually has landmark data for the header template
  const firstWithData = trial.landmarkData.find(f => f.landmarks?.length)
  if (!firstWithData) return null

  const numLandmarks = firstWithData.landmarks.length
  for (let i = 0; i < numLandmarks; i++) {
    headers.push(`lm${i}_x`, `lm${i}_y`, `lm${i}_z`)
    if (model === 'pose') headers.push(`lm${i}_vis`)
  }

  // Append world landmark columns when available (Pose and Hands models).
  // World landmarks are in meters, body-centered — the 3D metric coordinate system.
  const hasWorld = (model === 'pose' || model === 'hands') &&
    trial.landmarkData.some(f => f.worldLandmarks?.length)
  if (hasWorld) {
    for (let i = 0; i < numLandmarks; i++) {
      headers.push(`wlm${i}_x`, `wlm${i}_y`, `wlm${i}_z`)
    }
  }

  const rows = trial.landmarkData
    .filter(frame => frame.landmarks?.length === numLandmarks)
    .map(frame => {
      const row = [frame.timestamp.toFixed(1)]
      for (const lm of frame.landmarks) {
        row.push(lm.x.toFixed(6), lm.y.toFixed(6), lm.z.toFixed(6))
        if (model === 'pose') row.push((lm.visibility ?? 0).toFixed(4))
      }
      if (hasWorld) {
        for (let i = 0; i < numLandmarks; i++) {
          const wlm = frame.worldLandmarks?.[i]
          row.push(
            wlm ? wlm.x.toFixed(6) : '0',
            wlm ? wlm.y.toFixed(6) : '0',
            wlm ? wlm.z.toFixed(6) : '0',
          )
        }
      }
      return row.join(',')
    })

  return [headers.join(','), ...rows].join('\n')
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}
