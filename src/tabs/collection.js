import { listCameras, listCamerasAfterPermission, openCamera, stopCamera, loadModel, detectFrame, drawResults } from '../utils/mediapipe.js'
import { VoiceController } from '../utils/voice.js'
import { getAllCalibrations, saveSession, getAllSessions, saveSession as _ss, saveTrial, updateTrial, getTrialsBySession, getAllSessions as _gas, deleteSession, deleteTrial, downloadBlob, exportTrialCSV, getSession } from '../db.js'

let cameras = []
let calibrations = []
let sessions = []
let currentSession = null
let currentTrials = []

let videoEl = null
let overlayCanvas = null
let ctx = null
let landmarker = null
let currentModel = 'pose'
let activeStream = null
let mediaRecorder = null
let recordedChunks = []

let isFlipped = false
let isRecording = false
let trialStartTime = 0
let trialDuration = 30
let trialTimerId = null
let animFrameId = null
let currentLandmarkData = []
let currentTrialObj = null
let selectedTrialId = null

let voice = null

// expose voice status callback to main
let _onVoiceStatus = null
let _onCamStatus   = null

export async function initCollection(container, { onVoiceStatus, onCamStatus }) {
  _onVoiceStatus = onVoiceStatus
  _onCamStatus   = onCamStatus
  container.innerHTML = buildUI()
  await mountRefs(container)
  await refreshSelects(container)
  bindEvents(container)
  initVoice(container)
}

// ── UI ────────────────────────────────────────────────────────

function buildUI() {
  return `
<div class="two-col" style="align-items:start">

  <!-- Left: camera preview -->
  <div>
    <div class="card">
      <div class="card-title">Live Preview</div>

      <div class="form-row-inline">
        <div>
          <label>Camera</label>
          <select id="col-cam-sel"></select>
        </div>
        <div>
          <label>Model</label>
          <select id="col-model-sel">
            <option value="pose">Pose (Full Body)</option>
            <option value="hands">Hands</option>
            <option value="face">Face</option>
          </select>
        </div>
      </div>

      <div class="camera-wrap" id="col-camera-wrap">
        <video id="col-video" muted playsinline></video>
        <canvas id="col-overlay"></canvas>
        <button class="flip-btn" id="col-flip-btn" title="Mirror the camera view">⇔ Mirror</button>
        <div class="rec-badge" id="col-rec-badge"><div class="rec-dot"></div> REC</div>
        <div class="timer-display hidden" id="col-timer">0:30</div>
      </div>

      <div class="btn-group mt-8">
        <button class="btn btn-primary btn-sm" id="col-start-cam">▶ Start Camera</button>
        <button class="btn btn-ghost btn-sm"   id="col-stop-cam" disabled>■ Stop Camera</button>
      </div>
    </div>

    <!-- Voice control -->
    <div class="card">
      <div class="card-title">Voice Control</div>

      <!-- State banner -->
      <div id="col-voice-state-banner" style="
        display:flex;align-items:center;gap:10px;
        padding:10px 14px;border-radius:var(--radius);
        background:var(--surface2);border:1px solid var(--border);
        margin-bottom:10px">
        <span id="col-voice-mic" style="font-size:22px;line-height:1">🎙️</span>
        <div style="flex:1;min-width:0">
          <div id="col-voice-command-hint" style="font-size:12px;font-weight:700;color:var(--text-muted)">
            Voice off
          </div>
          <div id="col-voice-interim" style="
            font-size:11px;color:var(--accent);font-style:italic;
            white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
            min-height:15px;margin-top:2px">
          </div>
        </div>
        <button class="btn btn-ghost btn-sm" id="col-voice-toggle">Enable</button>
      </div>

      <!-- Accepted commands reference -->
      <div id="col-voice-cmds" style="
        display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px">
        <div id="col-cmd-start" style="
          padding:8px 10px;border-radius:var(--radius);
          border:1px solid var(--border);background:var(--bg);
          font-size:11px;opacity:.45">
          <div style="font-weight:700;color:var(--success);margin-bottom:3px">▶ START</div>
          <div style="color:var(--text-muted);line-height:1.6">
            "Begin trial"<br/>"Start trial"<br/>"Begin" / "Start"
          </div>
        </div>
        <div id="col-cmd-stop" style="
          padding:8px 10px;border-radius:var(--radius);
          border:1px solid var(--border);background:var(--bg);
          font-size:11px;opacity:.45">
          <div style="font-weight:700;color:var(--danger);margin-bottom:3px">■ STOP</div>
          <div style="color:var(--text-muted);line-height:1.6">
            "End trial"<br/>"Stop trial"<br/>"End" / "Stop"
          </div>
        </div>
      </div>

      <!-- Last heard -->
      <div style="font-size:11px;color:var(--text-muted)">
        Last heard: <span id="col-voice-last" style="color:var(--text);font-style:italic">—</span>
      </div>
    </div>
  </div>

  <!-- Right: session + trial controls -->
  <div>
    <!-- Session management -->
    <div class="card">
      <div class="card-title">Session</div>

      <div id="col-session-select-row">
        <div class="form-row">
          <label>Active Session</label>
          <select id="col-session-sel">
            <option value="">— Create or select a session —</option>
          </select>
        </div>
        <div class="btn-group mb-12">
          <button class="btn btn-ghost btn-sm" id="col-new-session">+ New Session</button>
          <button class="btn btn-ghost btn-sm" id="col-del-session" disabled>✕ Delete Session</button>
        </div>
      </div>

      <!-- New session form (hidden by default) -->
      <div id="col-new-session-form" class="hidden">
        <div class="form-row">
          <label>Session Name</label>
          <input type="text" id="col-session-name" placeholder="e.g., Participant 01 – Visit 1" />
        </div>
        <div class="form-row">
          <label>Calibration Profile</label>
          <select id="col-cal-sel">
            <option value="">None (pixel units)</option>
          </select>
        </div>
        <div class="form-row">
          <label>Notes</label>
          <textarea id="col-session-notes" rows="2" placeholder="Optional notes…" style="resize:vertical"></textarea>
        </div>
        <div class="btn-group">
          <button class="btn btn-success btn-sm" id="col-create-session">Create Session</button>
          <button class="btn btn-ghost btn-sm"   id="col-cancel-session">Cancel</button>
        </div>
      </div>
    </div>

    <!-- Trial recording -->
    <div class="card" id="col-trial-card">
      <div class="card-title">Trial Recording</div>

      <div class="form-row-inline">
        <div>
          <label>Trial Name</label>
          <input type="text" id="col-trial-name" placeholder="e.g., Trial 1 – rest" />
        </div>
        <div>
          <label>Duration (s)</label>
          <input type="number" id="col-duration" value="30" min="1" max="300" style="width:80px" />
        </div>
      </div>

      <div class="form-row">
        <label>Task Description</label>
        <input type="text" id="col-task-desc" placeholder="e.g., Reach for cup, 3 repetitions" />
      </div>

      <div class="progress-bar">
        <div class="progress-fill" id="col-progress" style="width:0%"></div>
      </div>

      <div class="btn-group mt-8">
        <button class="btn btn-success btn-lg" id="col-start-trial" disabled>▶ Begin Trial</button>
        <button class="btn btn-danger"         id="col-stop-trial"  disabled>■ End Trial</button>
      </div>
      <div id="col-trial-status" class="text-muted small mt-8">Select a session to start recording.</div>
    </div>

    <!-- Trial list for current session -->
    <div class="card">
      <div class="card-title">Trials in This Session</div>
      <div id="col-trial-list">
        <div class="empty-state">
          <div class="empty-icon">🎬</div>
          No trials yet.
        </div>
      </div>
      <div class="btn-group mt-8">
        <button class="btn btn-ghost btn-sm" id="col-export-session" disabled>⬇ Export Session CSV</button>
      </div>
    </div>
  </div>
</div>
`
}

// ── Mount & bind ───────────────────────────────────────────────

async function mountRefs(container) {
  videoEl       = container.querySelector('#col-video')
  overlayCanvas = container.querySelector('#col-overlay')
  ctx           = overlayCanvas.getContext('2d')

  cameras = await listCameras()
  const camSel = container.querySelector('#col-cam-sel')
  camSel.innerHTML = cameras.length
    ? cameras.map(c => `<option value="${c.deviceId}">${c.label}</option>`).join('')
    : '<option value="">No cameras found</option>'

  videoEl.addEventListener('loadedmetadata', () => {
    overlayCanvas.width  = videoEl.videoWidth
    overlayCanvas.height = videoEl.videoHeight
  })
}

async function refreshSelects(container) {
  calibrations = await getAllCalibrations()
  const calSel = container.querySelector('#col-cal-sel')
  if (calSel) {
    calSel.innerHTML = '<option value="">None (pixel units)</option>' +
      calibrations.map(c => `<option value="${c.id}">${c.name} (${c.pxPerMm?.toFixed(3)} px/mm)</option>`).join('')
  }

  sessions = await getAllSessions()
  const sesSel = container.querySelector('#col-session-sel')
  if (sesSel) {
    sesSel.innerHTML = '<option value="">— Create or select a session —</option>' +
      sessions.map(s => `<option value="${s.id}">${s.name}</option>`).join('')
  }
}

function bindEvents(container) {
  // Camera
  container.querySelector('#col-start-cam').addEventListener('click', () => startCamera(container))
  container.querySelector('#col-stop-cam').addEventListener('click',  () => stopCameraFn(container))

  // Model switching — reload MediaPipe while keeping the camera stream alive
  container.querySelector('#col-model-sel').addEventListener('change', (e) => {
    if (isRecording) {
      e.target.value = currentModel   // revert — can't switch mid-trial
      setStatus(container, 'Stop the current trial before switching models.')
      return
    }
    if (!videoEl.srcObject) {
      currentModel = e.target.value   // camera not running — apply on next Start
      return
    }
    switchModel(container, e.target.value)
  })

  container.querySelector('#col-flip-btn').addEventListener('click',  () => {
    isFlipped = !isFlipped
    const t = isFlipped ? 'scaleX(-1)' : ''
    container.querySelector('#col-video').style.transform   = t
    container.querySelector('#col-overlay').style.transform = t
    container.querySelector('#col-flip-btn').classList.toggle('active', isFlipped)
  })

  // Session
  container.querySelector('#col-new-session').addEventListener('click', () => {
    container.querySelector('#col-new-session-form').classList.remove('hidden')
  })
  container.querySelector('#col-cancel-session').addEventListener('click', () => {
    container.querySelector('#col-new-session-form').classList.add('hidden')
  })
  container.querySelector('#col-create-session').addEventListener('click', () => createSession(container))
  container.querySelector('#col-del-session').addEventListener('click',    () => deleteCurrentSession(container))
  container.querySelector('#col-session-sel').addEventListener('change',   (e) => selectSession(container, parseInt(e.target.value)))

  // Trial
  container.querySelector('#col-start-trial').addEventListener('click', () => startTrial(container))
  container.querySelector('#col-stop-trial').addEventListener('click',  () => stopTrial(container))
  container.querySelector('#col-export-session').addEventListener('click', () => exportSession(container))
}

function initVoice(container) {
  voice = new VoiceController({
    onStart: () => startTrial(container),
    onStop:  () => stopTrial(container),

    onInterim: (text) => {
      const el = container.querySelector('#col-voice-interim')
      if (el) el.textContent = text
    },

    onTranscript: (text) => {
      const el = container.querySelector('#col-voice-interim')
      if (el) el.textContent = ''
      const last = container.querySelector('#col-voice-last')
      if (last) last.textContent = `"${text}"`
    },

    onStatusChange: (s) => {
      const btn = container.querySelector('#col-voice-toggle')
      if (s === 'listening') {
        btn.textContent = 'Disable'
        _onVoiceStatus?.('listening')
      } else if (s === 'error') {
        btn.textContent = 'Enable'
        _onVoiceStatus?.('error')
      } else {
        btn.textContent = 'Enable'
        _onVoiceStatus?.('off')
      }
      updateVoiceUI(container, s)
    }
  })

  container.querySelector('#col-voice-toggle').addEventListener('click', () => {
    if (!voice.supported) {
      alert('Speech recognition is not supported in this browser. Use Chrome or Edge.')
      return
    }
    voice.toggle()
  })
}

// Update the voice panel to reflect current voice + recording state
function updateVoiceUI(container, voiceStatus) {
  const hint    = container.querySelector('#col-voice-command-hint')
  const mic     = container.querySelector('#col-voice-mic')
  const banner  = container.querySelector('#col-voice-state-banner')
  const cmdStart = container.querySelector('#col-cmd-start')
  const cmdStop  = container.querySelector('#col-cmd-stop')
  if (!hint) return

  const listening = voiceStatus === 'listening'

  if (!listening) {
    hint.textContent       = voiceStatus === 'error' ? 'Mic permission denied' : 'Voice off'
    hint.style.color       = voiceStatus === 'error' ? 'var(--danger)' : 'var(--text-muted)'
    mic.textContent        = '🎙️'
    banner.style.borderColor = 'var(--border)'
    cmdStart.style.opacity = '0.45'
    cmdStop.style.opacity  = '0.45'
    return
  }

  if (isRecording) {
    hint.textContent       = 'Listening — say "End trial" to stop'
    hint.style.color       = 'var(--danger)'
    mic.textContent        = '🔴'
    banner.style.borderColor = 'var(--danger)'
    cmdStart.style.opacity = '0.3'
    cmdStop.style.opacity  = '1'
  } else {
    hint.textContent       = 'Listening — say "Begin trial" to start'
    hint.style.color       = 'var(--success)'
    mic.textContent        = '🟢'
    banner.style.borderColor = 'var(--success)'
    cmdStart.style.opacity = '1'
    cmdStop.style.opacity  = '0.3'
  }
}

// ── Camera ────────────────────────────────────────────────────

function setCamOverlay(container, msg, isError = false) {
  let el = container.querySelector('#col-cam-overlay-msg')
  if (!el) {
    el = document.createElement('div')
    el.id = 'col-cam-overlay-msg'
    el.style.cssText = `
      position:absolute;inset:0;display:flex;flex-direction:column;
      align-items:center;justify-content:center;
      background:rgba(0,0,0,.75);color:#fff;font-size:13px;
      text-align:center;padding:16px;gap:8px;z-index:10;`
    container.querySelector('#col-camera-wrap').appendChild(el)
  }
  el.style.display = msg ? 'flex' : 'none'
  el.style.color = isError ? '#ef4444' : '#e2e8f0'
  el.innerHTML = msg
}

async function startCamera(container) {
  const camSel   = container.querySelector('#col-cam-sel')
  const deviceId = camSel.value
  const model    = container.querySelector('#col-model-sel').value
  currentModel   = model

  const startBtn = container.querySelector('#col-start-cam')
  const stopBtn  = container.querySelector('#col-stop-cam')
  startBtn.disabled    = true
  startBtn.textContent = 'Starting…'
  setCamOverlay(container, 'Requesting camera permission…')

  try {
    // Step 1: open camera stream (triggers browser permission prompt)
    console.log('[Camera] Opening stream, deviceId:', deviceId || '(any)')
    activeStream = await openCamera(deviceId, videoEl)
    console.log('[Camera] Stream opened:', activeStream.getVideoTracks()[0]?.label)
    _onCamStatus?.('active')
    setCamOverlay(container, '')  // clear overlay — video now visible

    // Step 2: re-enumerate with real labels now that permission is granted
    cameras = await listCamerasAfterPermission()
    const activeId = activeStream.getVideoTracks()[0]?.getSettings?.()?.deviceId ?? ''
    camSel.innerHTML = cameras.map(c =>
      `<option value="${c.deviceId}" ${c.deviceId === activeId ? 'selected' : ''}>${c.label}</option>`
    ).join('')

    // Step 3: load MediaPipe model (~10–20 MB, cached after first load)
    setStatus(container, 'Loading MediaPipe model — first load may take 10–30 s…')
    setCamOverlay(container, '⏳ Loading MediaPipe model…<br/><small style="color:#8892a4">First load: ~10–30 s</small>')
    console.log('[MediaPipe] Loading model:', model)
    landmarker = await loadModel(model)
    console.log('[MediaPipe] Model ready')
    setCamOverlay(container, '')

    setStatus(container, 'Ready — camera and model loaded.')
    startBtn.textContent = '▶ Start Camera'
    stopBtn.disabled     = false
    if (currentSession) container.querySelector('#col-start-trial').disabled = false

    startRenderLoop(container)
  } catch (err) {
    const msg = friendlyError(err)
    setStatus(container, msg)
    setCamOverlay(container, `⚠ ${msg}`, true)
    console.error('[Camera] startCamera error:', err)
    _onCamStatus?.('error')
    startBtn.disabled    = false
    startBtn.textContent = '▶ Start Camera'
  }
}

function friendlyError(err) {
  const name = err.name ?? ''
  if (name === 'NotAllowedError')  return 'Camera permission denied. Allow access in browser settings and try again.'
  if (name === 'NotFoundError')    return 'No camera found. Connect a camera and try again.'
  if (name === 'NotReadableError') return 'Camera is in use by another app. Close other apps and try again.'
  if (name === 'OverconstrainedError') return 'Selected camera could not be opened. Try a different camera.'
  if (err.message?.includes('Vision not initialized')) return 'MediaPipe failed to load. Check the status bar and reload the page.'
  return err.message ?? 'Unknown error'
}

const MODEL_LABELS = { pose: 'Pose (Full Body)', hands: 'Hands', face: 'Face' }

async function switchModel(container, model) {
  stopRenderLoop()
  ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height)
  const label = MODEL_LABELS[model] ?? model
  setCamOverlay(container, `⏳ Switching to ${label} model…<br/><small style="color:#8892a4">First load: ~10–30 s</small>`)
  setStatus(container, 'Switching model…')
  container.querySelector('#col-start-trial').disabled = true

  try {
    landmarker  = await loadModel(model)
    currentModel = model
    setCamOverlay(container, '')
    setStatus(container, `Model switched to ${label}.`)
    if (currentSession) container.querySelector('#col-start-trial').disabled = false
    startRenderLoop(container)
  } catch (err) {
    const msg = friendlyError(err)
    setCamOverlay(container, `⚠ ${msg}`, true)
    setStatus(container, msg)
    container.querySelector('#col-model-sel').value = currentModel  // revert selector
  }
}

function stopCameraFn(container) {
  stopRenderLoop()
  stopCamera(videoEl)
  activeStream = null
  setCamOverlay(container, '')
  if (ctx) ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height)
  container.querySelector('#col-start-cam').disabled = false
  container.querySelector('#col-stop-cam').disabled  = true
  _onCamStatus?.('idle')
  setStatus(container, 'Camera stopped.')
}

// ── Render loop ───────────────────────────────────────────────

function startRenderLoop(container) {
  let lastTs = -1

  function frame() {
    animFrameId = requestAnimationFrame(frame)
    if (videoEl.readyState < 2) return

    const nowMs = performance.now()
    if (nowMs === lastTs) return
    lastTs = nowMs

    const result = detectFrame(landmarker, currentModel, videoEl, nowMs)
    drawResults(ctx, result, currentModel, overlayCanvas.width, overlayCanvas.height)

    if (isRecording && result) {
      // Deep-copy landmark values — MediaPipe WASM recycles its result buffer
      // on the next detectForVideo call, so stored references go stale.
      const copyLm  = lm  => ({ x: lm.x, y: lm.y, z: lm.z, visibility: lm.visibility ?? 0 })
      const copyWLm = lm  => ({ x: lm.x, y: lm.y, z: lm.z })
      currentLandmarkData.push({
        timestamp:      nowMs - trialStartTime,
        landmarks:      result.landmarks?.map(copyLm)      ?? null,
        worldLandmarks: result.worldLandmarks?.map(copyWLm) ?? null,
        allHands:       result.allHands?.map(h => ({
          landmarks:      h.landmarks?.map(copyLm)       ?? null,
          worldLandmarks: h.worldLandmarks?.map(copyWLm) ?? null,
          handedness:     h.handedness,
        })) ?? null,
        handedness: result.handedness ?? null,
      })

      // Update progress bar
      const elapsed  = (nowMs - trialStartTime) / 1000
      const pct      = Math.min(elapsed / trialDuration * 100, 100)
      const remaining = Math.max(0, trialDuration - elapsed)
      const mins = Math.floor(remaining / 60)
      const secs = Math.floor(remaining % 60).toString().padStart(2, '0')
      const timerEl = container.querySelector('#col-timer')
      if (timerEl) timerEl.textContent = `${mins}:${secs}`
      const progEl = container.querySelector('#col-progress')
      if (progEl) progEl.style.width = `${pct}%`
    }
  }
  animFrameId = requestAnimationFrame(frame)
}

function stopRenderLoop() {
  if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null }
}

// ── Session management ────────────────────────────────────────

async function createSession(container) {
  const name  = container.querySelector('#col-session-name').value.trim()
  const notes = container.querySelector('#col-session-notes').value.trim()
  const calId = parseInt(container.querySelector('#col-cal-sel').value) || null
  const model = container.querySelector('#col-model-sel').value

  if (!name) { alert('Please enter a session name.'); return }

  const id = await saveSession({ name, notes, calibrationId: calId, model })
  container.querySelector('#col-new-session-form').classList.add('hidden')
  container.querySelector('#col-session-name').value = ''
  container.querySelector('#col-session-notes').value = ''

  await refreshSelects(container)
  container.querySelector('#col-session-sel').value = id
  await selectSession(container, id)
}

async function selectSession(container, id) {
  if (!id) { currentSession = null; return }
  currentSession = sessions.find(s => s.id === id) ?? await getSession(id)
  container.querySelector('#col-del-session').disabled = false
  container.querySelector('#col-start-trial').disabled = !videoEl.srcObject
  container.querySelector('#col-export-session').disabled = false
  currentTrials = await getTrialsBySession(id)
  renderTrialList(container)
  setStatus(container, `Session "${currentSession.name}" active.`)
}

async function deleteCurrentSession(container) {
  if (!currentSession) return
  if (!confirm(`Delete session "${currentSession.name}" and all its trials?`)) return
  await deleteSession(currentSession.id)
  currentSession = null
  currentTrials = []
  await refreshSelects(container)
  renderTrialList(container)
  container.querySelector('#col-del-session').disabled = true
  container.querySelector('#col-start-trial').disabled = true
  container.querySelector('#col-export-session').disabled = true
}

// ── Trial recording ───────────────────────────────────────────

async function startTrial(container) {
  if (!currentSession || isRecording) return
  if (!videoEl.srcObject) { setStatus(container, 'Start the camera first.'); return }

  const nameInput = container.querySelector('#col-trial-name')
  const trialName = nameInput.value.trim() ||
    `Trial ${currentTrials.length + 1} – ${new Date().toLocaleTimeString()}`
  const taskDesc  = container.querySelector('#col-task-desc').value.trim()
  trialDuration   = parseInt(container.querySelector('#col-duration').value) || 30

  isRecording        = true
  trialStartTime     = performance.now()
  currentLandmarkData = []

  // Start MediaRecorder on the raw camera stream
  recordedChunks = []
  try {
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9' : 'video/webm'
    mediaRecorder = new MediaRecorder(activeStream, { mimeType })
    mediaRecorder.ondataavailable = e => { if (e.data.size) recordedChunks.push(e.data) }
    mediaRecorder.start(250)  // collect every 250ms
  } catch (_) {
    // Recording not supported; continue without video
    mediaRecorder = null
  }

  // Create trial record in DB (will be updated on stop)
  const trialId = await saveTrial({
    sessionId:    currentSession.id,
    name:         trialName,
    taskDesc,
    model:        currentModel,
    calibrationId: currentSession.calibrationId ?? null,
    startTime:    Date.now(),
    endTime:      null,
    duration:     null,
    landmarkData: [],
    videoBlob:    null,
  })
  currentTrialObj = { id: trialId, name: trialName, taskDesc }

  // UI
  container.querySelector('#col-rec-badge').classList.add('show')
  container.querySelector('#col-timer').classList.remove('hidden')
  container.querySelector('#col-start-trial').disabled = true
  container.querySelector('#col-stop-trial').disabled  = false
  nameInput.value = ''
  setStatus(container, `Recording "${trialName}"…`)
  if (voice?.active) updateVoiceUI(container, 'listening')

  // Auto-stop after duration
  trialTimerId = setTimeout(() => stopTrial(container), trialDuration * 1000)
}

async function stopTrial(container) {
  if (!isRecording) return
  clearTimeout(trialTimerId)
  isRecording = false

  const endTime  = performance.now()
  const duration = (endTime - trialStartTime) / 1000

  // Stop media recorder
  let videoBlob = null
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    await new Promise(resolve => {
      mediaRecorder.onstop = resolve
      mediaRecorder.stop()
    })
    videoBlob = new Blob(recordedChunks, { type: 'video/webm' })
  }

  // Save to DB
  if (currentTrialObj) {
    await updateTrial({
      ...currentTrialObj,
      sessionId:    currentSession.id,
      taskDesc:     currentTrialObj.taskDesc,
      model:        currentModel,
      calibrationId: currentSession.calibrationId ?? null,
      startTime:    Date.now() - duration * 1000,
      endTime:      Date.now(),
      duration,
      landmarkData: currentLandmarkData,
      videoBlob,
    })
  }

  // UI
  container.querySelector('#col-rec-badge').classList.remove('show')
  container.querySelector('#col-timer').classList.add('hidden')
  container.querySelector('#col-progress').style.width = '0%'
  container.querySelector('#col-start-trial').disabled = false
  container.querySelector('#col-stop-trial').disabled  = true
  setStatus(container, `Trial saved. ${currentLandmarkData.length} frames, ${duration.toFixed(1)}s.`)
  if (voice?.active) updateVoiceUI(container, 'listening')

  currentTrials = await getTrialsBySession(currentSession.id)
  renderTrialList(container)
  currentTrialObj = null
}

// ── Trial list rendering ──────────────────────────────────────

function renderTrialList(container) {
  const listEl = container.querySelector('#col-trial-list')
  if (!listEl) return
  if (!currentTrials.length) {
    listEl.innerHTML = `<div class="empty-state"><div class="empty-icon">🎬</div>No trials yet.</div>`
    return
  }
  listEl.innerHTML = currentTrials.map(t => {
    const isRec      = t.id === currentTrialObj?.id
    const isSel      = t.id === selectedTrialId
    const hasVideo   = !!t.videoBlob
    const hasLm      = (t.landmarkData?.length ?? 0) > 0
    return `
    <div class="trial-item ${isRec ? 'recording' : ''} ${isSel ? 'selected' : ''}"
         data-trial-id="${t.id}" style="cursor:pointer">
      <div style="flex:1;min-width:0">
        <div class="trial-name">${t.name}</div>
        <div class="trial-meta">${t.taskDesc ?? ''} · ${t.duration?.toFixed(1) ?? '—'}s · ${t.landmarkData?.length ?? 0} frames</div>
      </div>
      <span class="trial-badge">${(t.model ?? 'pose').toUpperCase()}</span>
      <button class="btn btn-ghost btn-sm dl-csv" data-id="${t.id}" title="Download CSV"
              ${hasLm ? '' : 'disabled'} style="font-size:14px;padding:2px 5px">📊</button>
      <button class="btn btn-ghost btn-sm dl-vid" data-id="${t.id}" title="Download Video"
              ${hasVideo ? '' : 'disabled'} style="font-size:14px;padding:2px 5px">🎬</button>
      <button class="btn btn-ghost btn-sm del-trial" data-id="${t.id}" title="Delete trial">✕</button>
    </div>`
  }).join('')

  // Click row to select/deselect
  listEl.querySelectorAll('[data-trial-id]').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.closest('button')) return
      const id = parseInt(row.dataset.trialId)
      selectedTrialId = (selectedTrialId === id) ? null : id
      renderTrialList(container)
    })
  })

  // Per-trial CSV download
  listEl.querySelectorAll('.dl-csv').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation()
      const trial = currentTrials.find(t => t.id === parseInt(btn.dataset.id))
      if (!trial) return
      const csv = exportTrialCSV(trial)
      if (csv) {
        downloadBlob(new Blob([csv], { type: 'text/csv' }), `${currentSession.name}_${trial.name}.csv`)
      } else {
        alert('No landmark data found for this trial.')
      }
    })
  })

  // Per-trial video download
  listEl.querySelectorAll('.dl-vid').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation()
      const trial = currentTrials.find(t => t.id === parseInt(btn.dataset.id))
      if (trial?.videoBlob) downloadBlob(trial.videoBlob, `${currentSession.name}_${trial.name}.webm`)
    })
  })

  // Delete trial
  listEl.querySelectorAll('.del-trial').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation()
      const id = parseInt(btn.dataset.id)
      await deleteTrial(id)
      if (selectedTrialId === id) selectedTrialId = null
      currentTrials = await getTrialsBySession(currentSession.id)
      renderTrialList(container)
    })
  })
}

// ── Export ────────────────────────────────────────────────────

async function exportSession(container) {
  if (!currentSession) return
  const btn = container.querySelector('#col-export-session')
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Exporting…' }

  const delay = () => new Promise(r => setTimeout(r, 400))
  let count = 0

  for (const trial of currentTrials) {
    const csv = exportTrialCSV(trial)
    if (csv) {
      downloadBlob(new Blob([csv], { type: 'text/csv' }), `${currentSession.name}_${trial.name}.csv`)
      count++
      await delay()
    }
    if (trial.videoBlob) {
      downloadBlob(trial.videoBlob, `${currentSession.name}_${trial.name}.webm`)
      count++
      await delay()
    }
  }

  if (btn) { btn.disabled = false; btn.textContent = '⬇ Export Session CSV' }
  setStatus(container, `Exported ${count} file(s) for ${currentTrials.length} trial(s).`)
}

function setStatus(container, msg) {
  const el = container.querySelector('#col-trial-status')
  if (el) el.textContent = msg
}

// Called by main.js when leaving this tab
export function deactivateCollection() {
  if (isRecording) {
    clearTimeout(trialTimerId)
    isRecording = false
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop()
  }
  stopRenderLoop()
  stopCamera(videoEl)
  activeStream = null
  voice?.stop()
  _onVoiceStatus?.('off')

  // Reset camera button state
  const startBtn = document.querySelector('#col-start-cam')
  const stopBtn  = document.querySelector('#col-stop-cam')
  if (startBtn) { startBtn.disabled = false; startBtn.textContent = '▶ Start Camera' }
  if (stopBtn)  stopBtn.disabled = true
  const overlay = document.querySelector('#col-cam-overlay-msg')
  if (overlay) overlay.style.display = 'none'
}
