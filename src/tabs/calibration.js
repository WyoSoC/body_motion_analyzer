import { listCameras, listCamerasAfterPermission, openCamera, stopCamera } from '../utils/mediapipe.js'
import { saveCalibration, getAllCalibrations, deleteCalibration } from '../db.js'

// ── Module state ──────────────────────────────────────────────
let cameras      = []
let activeStream = null
let videoEl      = null
let overlayCanvas = null
let ctx          = null
let calibrations = []

let calMethod    = 'ruler'        // 'ruler' | 'checkerboard'
let clickPoints  = []             // ruler: [{x,y}] canvas coords
let _lastPxPerMm = null
let isFlipped    = false

// Checkerboard auto-detect
let detecting    = false
let detectRAF    = null
let _worker      = null

// ── Entry point ───────────────────────────────────────────────

export async function initCalibration(container) {
  container.innerHTML = buildUI()
  await mountRefs(container)
  await loadCalibrationList()
  bindEvents(container)
  switchMethod(container, 'ruler')
}

// ── UI ────────────────────────────────────────────────────────

function buildUI() {
  return `
<div class="two-col" style="align-items:start">

  <!-- Left: camera preview -->
  <div>
    <div class="card">
      <div class="card-title">Camera Preview</div>
      <div class="form-row">
        <label>Camera</label>
        <select id="cal-camera-select"><option>Enumerating…</option></select>
      </div>
      <div class="camera-wrap calibration-wrap" id="cal-camera-wrap">
        <video id="cal-video" muted playsinline></video>
        <canvas id="cal-overlay"></canvas>
        <span class="camera-label" id="cal-cam-label">No camera</span>
        <button class="flip-btn" id="cal-flip-btn" title="Mirror the camera view">⇔ Mirror</button>
      </div>
      <div class="btn-group mt-8">
        <button class="btn btn-ghost btn-sm" id="cal-start-cam">▶ Start Camera</button>
        <button class="btn btn-ghost btn-sm" id="cal-stop-cam" disabled>■ Stop</button>
        <button class="btn btn-ghost btn-sm" id="cal-clear-pts">✕ Clear</button>
      </div>
    </div>

    <!-- Dynamic instructions -->
    <div class="card" id="cal-instructions">
      <div class="card-title">Instructions</div>
      <div id="cal-instr-body"></div>
    </div>
  </div>

  <!-- Right: form + list -->
  <div>
    <div class="card">
      <div class="card-title">New Calibration Profile</div>

      <div class="form-row">
        <label>Profile Name</label>
        <input type="text" id="cal-name" placeholder="e.g., Lab Cam A" />
      </div>

      <!-- Method toggle -->
      <div class="form-row">
        <label>Method</label>
        <div class="toggle-group">
          <button class="toggle-chip active" id="cal-method-ruler"        data-method="ruler">Ruler</button>
          <button class="toggle-chip"        id="cal-method-checkerboard" data-method="checkerboard">Checkerboard (auto)</button>
        </div>
      </div>

      <!-- ── Ruler fields ── -->
      <div id="cal-ruler-fields">
        <div class="form-row-inline">
          <div style="flex:2">
            <label>Known distance between the 2 clicked points</label>
            <input type="number" id="cal-ruler-dist" value="500" min="0.1" step="0.1" />
          </div>
          <div style="flex:1">
            <label>Unit</label>
            <select id="cal-ruler-unit">
              <option value="mm">mm</option>
              <option value="in">inches</option>
            </select>
          </div>
        </div>
        <div id="cal-points-info" style="font-size:12px;color:var(--text-muted);margin-bottom:10px">
          Click 2 points on the camera preview to mark the known distance.
        </div>
      </div>

      <!-- ── Checkerboard fields ── -->
      <div id="cal-cb-fields" class="hidden">
        <div class="form-row-inline">
          <div>
            <label>Inner Cols</label>
            <input type="number" id="cal-cols" value="9" min="2" max="20" />
          </div>
          <div>
            <label>Inner Rows</label>
            <input type="number" id="cal-rows" value="6" min="2" max="20" />
          </div>
          <div>
            <label>Square size (mm)</label>
            <input type="number" id="cal-square-mm" value="20" min="1" max="200" step="0.5" />
          </div>
        </div>
        <div id="cal-detect-status" style="
          padding:8px 12px;border-radius:var(--radius);
          background:var(--surface2);border:1px solid var(--border);
          font-size:12px;color:var(--text-muted);margin-bottom:10px">
          Start the camera, then click <strong>Start Detection</strong>.
        </div>
        <div class="btn-group mb-12">
          <button class="btn btn-primary btn-sm" id="cal-detect-btn">Start Detection</button>
          <button class="btn btn-ghost btn-sm"   id="cal-stop-detect-btn" disabled>Stop</button>
        </div>
      </div>

      <!-- Shared result + save -->
      <div id="cal-result" class="hidden" style="
        padding:10px 14px;border-radius:var(--radius);
        background:rgba(62,207,112,.1);border:1px solid rgba(62,207,112,.3);
        font-size:13px;margin-bottom:12px">
      </div>

      <div class="btn-group">
        <button class="btn btn-primary" id="cal-calc-btn"  disabled>Calculate</button>
        <button class="btn btn-success" id="cal-save-btn"  disabled>Save Profile</button>
      </div>
    </div>

    <!-- Saved profiles -->
    <div class="card">
      <div class="card-title">Saved Calibration Profiles</div>
      <div id="cal-list">
        <div class="empty-state"><div class="empty-icon">📐</div>No profiles yet.</div>
      </div>
    </div>
  </div>
</div>`
}

// ── Mount ─────────────────────────────────────────────────────

async function mountRefs(container) {
  videoEl       = container.querySelector('#cal-video')
  overlayCanvas = container.querySelector('#cal-overlay')
  ctx           = overlayCanvas.getContext('2d')

  cameras = await listCameras()
  const sel = container.querySelector('#cal-camera-select')
  sel.innerHTML = cameras.length
    ? cameras.map(c => `<option value="${c.deviceId}">${c.label}</option>`).join('')
    : '<option value="">No cameras found</option>'

  videoEl.addEventListener('loadedmetadata', () => {
    overlayCanvas.width  = videoEl.videoWidth
    overlayCanvas.height = videoEl.videoHeight
  })
}

// ── Events ────────────────────────────────────────────────────

function bindEvents(container) {
  container.querySelector('#cal-start-cam').addEventListener('click', () => startCamera(container))
  container.querySelector('#cal-stop-cam').addEventListener('click',  () => stopCameraFn(container))
  container.querySelector('#cal-clear-pts').addEventListener('click', () => clearState(container))
  container.querySelector('#cal-calc-btn').addEventListener('click',  () => calculate(container))
  container.querySelector('#cal-save-btn').addEventListener('click',  () => saveCal(container))
  container.querySelector('#cal-flip-btn').addEventListener('click',  () => toggleFlip(container))

  // Method toggle
  container.querySelectorAll('[data-method]').forEach(btn => {
    btn.addEventListener('click', () => switchMethod(container, btn.dataset.method))
  })

  // Ruler: canvas click
  overlayCanvas.addEventListener('click', (e) => {
    if (calMethod === 'ruler') handleCanvasClick(e, container)
  })

  // Checkerboard auto-detect
  container.querySelector('#cal-detect-btn').addEventListener('click', () => startDetection(container))
  container.querySelector('#cal-stop-detect-btn').addEventListener('click', () => stopDetection(container))
}

// ── Flip ──────────────────────────────────────────────────────

function toggleFlip(container) {
  isFlipped = !isFlipped
  const t = isFlipped ? 'scaleX(-1)' : ''
  container.querySelector('#cal-video').style.transform   = t
  container.querySelector('#cal-overlay').style.transform = t
  container.querySelector('#cal-flip-btn').classList.toggle('active', isFlipped)
  clearState(container)  // ruler points are no longer valid after a flip
}

// ── Method switch ─────────────────────────────────────────────

function switchMethod(container, method) {
  calMethod = method
  stopDetection(container)
  clearState(container)

  container.querySelectorAll('[data-method]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.method === method)
  })

  const rulerFields = container.querySelector('#cal-ruler-fields')
  const cbFields    = container.querySelector('#cal-cb-fields')

  if (method === 'ruler') {
    rulerFields.classList.remove('hidden')
    cbFields.classList.add('hidden')
    overlayCanvas.style.cursor = 'crosshair'
    setInstructions(container, `
      <p style="font-size:13px;color:var(--text);margin-bottom:10px">
        Calibration can be performed with a ruler or an object of known length.
        You can also print out a Letter Size checkerboard for automated calibration —
        <a href="./checkerboard-calibration.pdf" download
           style="color:var(--accent);text-underline-offset:2px">⬇ Download</a>.
      </p>
      <ol style="padding-left:16px;line-height:2;font-size:13px;color:var(--text-muted)">
        <li>Start the camera.</li>
        <li>Place a ruler or object of known length flat in the scene where the subject will move.</li>
        <li><strong>Click 2 points</strong> on the preview — e.g. the 0 cm and 10 cm marks.</li>
        <li>Enter the real distance between those two points and choose <em>mm</em> or <em>inches</em>.</li>
        <li>Click <strong>Calculate</strong>, then <strong>Save Profile</strong>.</li>
      </ol>`)
  } else {
    rulerFields.classList.add('hidden')
    cbFields.classList.remove('hidden')
    overlayCanvas.style.cursor = 'default'
    setInstructions(container, `
      <ol style="padding-left:16px;line-height:2;font-size:13px;color:var(--text-muted)">
        <li>Start the camera.</li>
        <li>Print the calibration checkerboard —
          <a href="./checkerboard-calibration.pdf" download
             style="color:var(--accent);text-underline-offset:2px">
            ⬇ Download checkerboard-calibration.pdf
          </a>
        </li>
        <li>Set Inner Cols, Inner Rows and Square Size to match your printout.</li>
        <li>Hold the board flat, facing the camera.</li>
        <li>Click <strong>Start Detection</strong> — OpenCV will find the corners automatically.</li>
        <li>When corners are detected the overlay turns green. Click <strong>Capture</strong> to save the scale.</li>
      </ol>
      <p style="font-size:11px;color:var(--text-muted);margin-top:8px">
        ⚠ OpenCV.js (~10 MB) loads in the background — the page stays responsive while it initializes.
      </p>`)
  }
}

function setInstructions(container, html) {
  container.querySelector('#cal-instr-body').innerHTML = html
}

// ── Camera ────────────────────────────────────────────────────

async function startCamera(container) {
  const sel      = container.querySelector('#cal-camera-select')
  const deviceId = sel.value
  try {
    activeStream = await openCamera(deviceId, videoEl)
    cameras = await listCamerasAfterPermission()
    const activeId = activeStream.getVideoTracks()[0]?.getSettings?.()?.deviceId ?? ''
    sel.innerHTML = cameras.map(c =>
      `<option value="${c.deviceId}" ${c.deviceId === activeId ? 'selected' : ''}>${c.label}</option>`
    ).join('')
    container.querySelector('#cal-start-cam').disabled = true
    container.querySelector('#cal-stop-cam').disabled  = false
    container.querySelector('#cal-cam-label').textContent =
      cameras.find(c => c.deviceId === activeId)?.label ?? 'Camera'
  } catch (err) {
    alert(`Camera error: ${err.message}`)
  }
}

function stopCameraFn(container) {
  stopDetection(container)
  stopCamera(videoEl)
  activeStream = null
  clearState(container)
  container.querySelector('#cal-start-cam').disabled = false
  container.querySelector('#cal-stop-cam').disabled  = true
}

// ── Clear ─────────────────────────────────────────────────────

function clearState(container) {
  clickPoints  = []
  _lastPxPerMm = null
  ctx?.clearRect(0, 0, overlayCanvas?.width, overlayCanvas?.height)

  const info = container.querySelector('#cal-points-info')
  if (info) info.textContent = 'Click 2 points on the camera preview to mark the known distance.'
  container.querySelector('#cal-calc-btn').disabled = true
  container.querySelector('#cal-result').classList.add('hidden')
  container.querySelector('#cal-save-btn').disabled = true
}

// ── Ruler: 2-click ────────────────────────────────────────────

function handleCanvasClick(e, container) {
  if (!videoEl.srcObject) return
  const rect  = overlayCanvas.getBoundingClientRect()
  const scaleX = overlayCanvas.width  / rect.width
  const scaleY = overlayCanvas.height / rect.height
  let x = (e.clientX - rect.left) * scaleX
  const y = (e.clientY - rect.top)  * scaleY
  if (isFlipped) x = overlayCanvas.width - x

  if (clickPoints.length >= 2) clickPoints = []
  clickPoints.push({ x, y })
  redrawRulerOverlay()

  const info = container.querySelector('#cal-points-info')
  if (clickPoints.length === 1) {
    info.textContent = 'Point 1 set. Click the second point.'
  } else {
    const dx   = clickPoints[1].x - clickPoints[0].x
    const dy   = clickPoints[1].y - clickPoints[0].y
    const dist = Math.sqrt(dx * dx + dy * dy).toFixed(1)
    info.textContent = `2 points set — pixel distance: ${dist} px. Click Calculate.`
    container.querySelector('#cal-calc-btn').disabled = false
  }
}

function redrawRulerOverlay() {
  ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height)
  if (clickPoints.length === 2) {
    ctx.beginPath()
    ctx.moveTo(clickPoints[0].x, clickPoints[0].y)
    ctx.lineTo(clickPoints[1].x, clickPoints[1].y)
    ctx.strokeStyle = '#f59e0b'
    ctx.lineWidth   = 2
    ctx.setLineDash([6, 4])
    ctx.stroke()
    ctx.setLineDash([])
  }
  clickPoints.forEach((p, i) => {
    ctx.beginPath()
    ctx.arc(p.x, p.y, 7, 0, Math.PI * 2)
    ctx.fillStyle   = i === 0 ? '#f59e0b' : '#ef4444'
    ctx.strokeStyle = '#fff'
    ctx.lineWidth   = 2
    ctx.fill(); ctx.stroke()
    ctx.fillStyle = '#fff'
    ctx.font      = 'bold 12px sans-serif'
    ctx.fillText(`P${i + 1}`, p.x + 10, p.y - 8)
  })
}

// ── Calculate (ruler) ─────────────────────────────────────────

function calculate(container) {
  if (calMethod !== 'ruler' || clickPoints.length < 2) return
  const rawDist = parseFloat(container.querySelector('#cal-ruler-dist').value)
  const unit    = container.querySelector('#cal-ruler-unit').value
  if (!rawDist || rawDist <= 0) { alert('Enter a valid distance.'); return }

  const realMm = unit === 'in' ? rawDist * 25.4 : rawDist
  const dx     = clickPoints[1].x - clickPoints[0].x
  const dy     = clickPoints[1].y - clickPoints[0].y
  const pxDist = Math.sqrt(dx * dx + dy * dy)
  _lastPxPerMm = pxDist / realMm

  const displayDist = unit === 'in'
    ? `${rawDist} in (${realMm.toFixed(2)} mm)`
    : `${realMm.toFixed(2)} mm`

  showResult(container, `
    <strong>Scale factor:</strong> ${_lastPxPerMm.toFixed(4)} px/mm<br/>
    <span style="color:var(--text-muted);font-size:11px">
      Pixel distance: ${pxDist.toFixed(1)} px → ${displayDist}
    </span>`)
}

function showResult(container, html) {
  const el = container.querySelector('#cal-result')
  el.innerHTML = html
  el.classList.remove('hidden')
  container.querySelector('#cal-save-btn').disabled = false
}

// ── Checkerboard auto-detection (Web Worker) ──────────────────

function startDetection(container) {
  if (!videoEl.srcObject) { alert('Start the camera first.'); return }

  const cols = parseInt(container.querySelector('#cal-cols').value)
  const rows = parseInt(container.querySelector('#cal-rows').value)

  setDetectStatus(container, 'loading', 'Loading OpenCV.js in background…')
  container.querySelector('#cal-detect-btn').disabled      = true
  container.querySelector('#cal-stop-detect-btn').disabled = false

  detecting = true
  let workerReady  = false
  let workerBusy   = false
  let stableFrames = 0

  _worker = new Worker(`${import.meta.env.BASE_URL}vendor/cv-worker.js`)

  _worker.onerror = () => {
    setDetectStatus(container, 'error', 'OpenCV.js failed to load. Please reload and try again.')
    container.querySelector('#cal-detect-btn').disabled      = false
    container.querySelector('#cal-stop-detect-btn').disabled = true
    detecting = false
    _worker = null
  }

  _worker.onmessage = (e) => {
    const { type, corners, avgPx } = e.data

    if (type === 'ready') {
      workerReady = true
      setDetectStatus(container, 'scanning', `Scanning for ${cols}×${rows} checkerboard…`)
      return
    }

    workerBusy = false
    if (!detecting) return

    if (type === 'result') {
      stableFrames++
      drawCornersOverlay(corners, cols, rows, '#3ecf70')
      setDetectStatus(container, 'found',
        `✔ Detected (${stableFrames} frame${stableFrames > 1 ? 's' : ''}) — avg square: ${avgPx.toFixed(1)} px`)
      if (stableFrames >= 5) {
        setDetectStatus(container, 'ready',
          `✔ Stable detection — click <strong>Capture</strong> to compute scale.`)
        stopDetectionLoop()
        showCaptureButton(container, { corners, avgPx })
      }
    } else {
      stableFrames = 0
      ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height)
      setDetectStatus(container, 'scanning', `Scanning for ${cols}×${rows} checkerboard…`)
    }
  }

  function loop() {
    if (!detecting) return
    detectRAF = requestAnimationFrame(loop)
    if (!workerReady || workerBusy || videoEl.readyState < 2) return

    const w = videoEl.videoWidth, h = videoEl.videoHeight
    const tmp = document.createElement('canvas')
    tmp.width = w; tmp.height = h
    tmp.getContext('2d').drawImage(videoEl, 0, 0)
    const imageData = tmp.getContext('2d').getImageData(0, 0, w, h)

    workerBusy = true
    _worker.postMessage(
      { type: 'detect', buffer: imageData.data.buffer, width: w, height: h, cols, rows },
      [imageData.data.buffer]
    )
  }
  detectRAF = requestAnimationFrame(loop)
}

function stopDetection(container) {
  stopDetectionLoop()
  detecting = false
  if (_worker) { _worker.terminate(); _worker = null }
  ctx?.clearRect(0, 0, overlayCanvas?.width, overlayCanvas?.height)
  const detectBtn = container?.querySelector('#cal-detect-btn')
  const stopBtn   = container?.querySelector('#cal-stop-detect-btn')
  if (detectBtn) detectBtn.disabled = false
  if (stopBtn)   stopBtn.disabled   = true
  const captureBtn = container?.querySelector('#cal-capture-btn')
  if (captureBtn) captureBtn.remove()
  setDetectStatus(container, 'idle', 'Detection stopped.')
}

function stopDetectionLoop() {
  detecting = false
  if (detectRAF) { cancelAnimationFrame(detectRAF); detectRAF = null }
}

function showCaptureButton(container, result) {
  const existing = container.querySelector('#cal-capture-btn')
  if (existing) existing.remove()

  const btn = document.createElement('button')
  btn.id        = 'cal-capture-btn'
  btn.className = 'btn btn-success mt-8'
  btn.textContent = '📸 Capture & Calculate'
  btn.addEventListener('click', () => {
    const squareMm  = parseFloat(container.querySelector('#cal-square-mm').value)
    _lastPxPerMm    = result.avgPx / squareMm
    btn.remove()
    showResult(container, `
      <strong>Scale factor:</strong> ${_lastPxPerMm.toFixed(4)} px/mm<br/>
      <span style="color:var(--text-muted);font-size:11px">
        Avg square: ${result.avgPx.toFixed(1)} px → ${squareMm} mm
        (${container.querySelector('#cal-cols').value}×${container.querySelector('#cal-rows').value} inner corners)
      </span>`)
    ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height)
    container.querySelector('#cal-detect-btn').disabled      = false
    container.querySelector('#cal-stop-detect-btn').disabled = true
  })

  container.querySelector('#cal-cb-fields').appendChild(btn)
}

function setDetectStatus(container, state, msg) {
  const el = container?.querySelector('#cal-detect-status')
  if (!el) return
  const colors = {
    idle:     'var(--text-muted)',
    loading:  'var(--warning)',
    scanning: 'var(--accent)',
    found:    'var(--success)',
    ready:    'var(--success)',
    error:    'var(--danger)',
  }
  el.style.color  = colors[state] ?? 'var(--text-muted)'
  el.style.borderColor = state === 'found' || state === 'ready'
    ? 'rgba(62,207,112,.3)' : 'var(--border)'
  el.innerHTML = msg
}

function drawCornersOverlay(cornersData, cols, rows, color = '#3ecf70') {
  // cornersData is a flat [x,y,x,y,…] array of detected square centres
  const scaleX = overlayCanvas.width  / videoEl.videoWidth
  const scaleY = overlayCanvas.height / videoEl.videoHeight
  ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height)

  const n = cornersData.length / 2
  for (let i = 0; i < n; i++) {
    const cx = cornersData[i * 2]     * scaleX
    const cy = cornersData[i * 2 + 1] * scaleY
    ctx.beginPath()
    ctx.arc(cx, cy, 6, 0, Math.PI * 2)
    ctx.fillStyle   = color + 'bb'
    ctx.strokeStyle = '#000'
    ctx.lineWidth   = 1.5
    ctx.fill(); ctx.stroke()
  }
}

// ── Save ──────────────────────────────────────────────────────

async function saveCal(container) {
  if (!_lastPxPerMm) return
  const name = container.querySelector('#cal-name').value.trim() || `Cal ${new Date().toLocaleString()}`
  const meta = calMethod === 'checkerboard'
    ? {
        squareSizeMm: parseFloat(container.querySelector('#cal-square-mm').value),
        checkCols:    parseInt(container.querySelector('#cal-cols').value),
        checkRows:    parseInt(container.querySelector('#cal-rows').value),
      }
    : {
        rulerDistMm: parseFloat(container.querySelector('#cal-ruler-unit').value === 'in'
          ? container.querySelector('#cal-ruler-dist').value * 25.4
          : container.querySelector('#cal-ruler-dist').value),
      }

  await saveCalibration({
    name,
    method: calMethod,
    pxPerMm: _lastPxPerMm,
    cameraLabel: cameras.find(c =>
      c.deviceId === container.querySelector('#cal-camera-select').value)?.label ?? '',
    ...meta,
  })
  await loadCalibrationList()
  container.querySelector('#cal-save-btn').disabled = true
  container.querySelector('#cal-result').innerHTML +=
    `<br/><span class="text-success">✔ Saved as "${name}"</span>`
}

// ── Profile list ──────────────────────────────────────────────

async function loadCalibrationList() {
  calibrations = await getAllCalibrations()
  const listEl = document.querySelector('#cal-list')
  if (!listEl) return

  if (!calibrations.length) {
    listEl.innerHTML = `<div class="empty-state"><div class="empty-icon">📐</div>No profiles yet.</div>`
    return
  }

  listEl.innerHTML = calibrations.map(c => {
    const methodBadge = c.method === 'checkerboard'
      ? `<span class="trial-badge" style="background:rgba(91,127,255,.2);color:var(--accent)">CB</span>`
      : `<span class="trial-badge" style="background:rgba(62,207,112,.2);color:var(--success)">Ruler</span>`
    return `
    <div class="trial-item">
      <div style="flex:1">
        <div class="trial-name">${c.name}</div>
        <div class="trial-meta">
          ${c.pxPerMm?.toFixed(4)} px/mm · ${c.cameraLabel} · ${new Date(c.date).toLocaleDateString()}
        </div>
      </div>
      ${methodBadge}
      <button class="btn btn-ghost btn-sm del-cal" data-id="${c.id}">✕</button>
    </div>`
  }).join('')

  listEl.querySelectorAll('.del-cal').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation()
      await deleteCalibration(parseInt(btn.dataset.id))
      await loadCalibrationList()
    })
  })
}

// ── Exports ───────────────────────────────────────────────────

export function getCalibrations() { return calibrations }

export function deactivateCalibration() {
  stopDetectionLoop()
  if (_worker) { _worker.terminate(); _worker = null }
  stopCamera(videoEl)
  activeStream = null
  const startBtn = document.querySelector('#cal-start-cam')
  const stopBtn  = document.querySelector('#cal-stop-cam')
  if (startBtn) startBtn.disabled = false
  if (stopBtn)  stopBtn.disabled  = true
}
