import { initVision, stopAllCameraStreams } from './utils/mediapipe.js'
import { getDB } from './db.js'
import { initCalibration, deactivateCalibration } from './tabs/calibration.js'
import { initCollection, deactivateCollection } from './tabs/collection.js'
import { initAnalysis, refreshAnalysis } from './tabs/analysis.js'
import { initFMS, refreshFMS, deactivateFMS } from './tabs/fms.js'

// ── Status chips ──────────────────────────────────────────────

const mpStatus    = document.getElementById('mp-status')
const camStatus   = document.getElementById('cam-status')
const voiceStatus = document.getElementById('voice-status')

function setChip(el, label, cls) {
  el.textContent = label
  el.className = `status-chip ${cls}`
}

// ── Tab routing ───────────────────────────────────────────────

const tabBtns     = document.querySelectorAll('.tab-btn')
const tabContents = document.querySelectorAll('.tab-content')

let initialized  = { calibration: false, collection: false, analysis: false, fms: false }
let activeTabId  = null

async function activateTab(tabId) {
  // Deactivate the current tab — stop its camera, render loops, etc.
  if (activeTabId && activeTabId !== tabId) {
    stopAllCameraStreams()
    if (activeTabId === 'calibration') deactivateCalibration()
    if (activeTabId === 'collection')  deactivateCollection()
    if (activeTabId === 'fms')         deactivateFMS()
    setChip(camStatus, 'Camera: Idle', 'status-idle')
  }
  activeTabId = tabId

  tabBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === tabId))
  tabContents.forEach(t => t.classList.toggle('active', t.id === `tab-${tabId}`))

  const container = document.getElementById(`tab-${tabId}`)

  if (tabId === 'calibration' && !initialized.calibration) {
    initialized.calibration = true
    await initCalibration(container)
  }

  if (tabId === 'collection' && !initialized.collection) {
    initialized.collection = true
    await initCollection(container, {
      onVoiceStatus: (s) => {
        const labels = { listening: 'Voice: On', off: 'Voice: Off', error: 'Voice: Error' }
        const clses  = { listening: 'status-listening', off: 'status-idle', error: 'status-error' }
        setChip(voiceStatus, labels[s] ?? 'Voice: Off', clses[s] ?? 'status-idle')
      },
      onCamStatus: (s) => {
        const labels = { active: 'Camera: Live', idle: 'Camera: Idle', error: 'Camera: Error' }
        const clses  = { active: 'status-active', idle: 'status-idle', error: 'status-error' }
        setChip(camStatus, labels[s] ?? 'Camera: Idle', clses[s] ?? 'status-idle')
      }
    })
  }

  if (tabId === 'analysis') {
    if (!initialized.analysis) {
      initialized.analysis = true
      await initAnalysis(container)
    } else {
      // Re-activating: pull in any trials recorded since the last visit.
      await refreshAnalysis(container)
    }
  }

  if (tabId === 'fms') {
    if (!initialized.fms) {
      initialized.fms = true
      await initFMS(container)
    } else {
      // Re-activating: pull in any trials recorded since the last visit.
      await refreshFMS(container)
    }
  }
}

tabBtns.forEach(btn => {
  btn.addEventListener('click', () => activateTab(btn.dataset.tab))
})

// ── Bootstrap ─────────────────────────────────────────────────

async function bootstrap() {
  setChip(mpStatus, 'MediaPipe: Loading…', 'status-loading')

  await getDB()

  try {
    await initVision()
    setChip(mpStatus, 'MediaPipe: Ready', 'status-active')
  } catch (err) {
    setChip(mpStatus, 'MediaPipe: Error', 'status-error')
    console.error('[MediaPipe] init failed:', err)
  }

  await activateTab('calibration')
}

bootstrap()
