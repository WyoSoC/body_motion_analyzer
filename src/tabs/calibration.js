import { listCameras, listCamerasAfterPermission, openCamera, stopCamera } from '../utils/mediapipe.js'
import { saveCalibration, getAllCalibrations, deleteCalibration } from '../db.js'
import { downloadCheckerboard, downloadCharucoBoard } from '../utils/board_print.js'

const STABLE_FRAMES = 3   // consecutive detections before auto-computing result

// ── Module state ──────────────────────────────────────────────
let cameras      = []
let activeStream = null
let videoEl      = null
let overlayCanvas = null
let ctx          = null
let calibrations = []

let calMethod    = 'ruler'        // 'ruler' | 'checkerboard' | 'charuco'
let clickPoints  = []             // ruler: [{x,y}] canvas coords
let _lastPxPerMm = null
let isFlipped    = false

// Board auto-detect
let detecting    = false
let detectRAF    = null
let _worker      = null
let _workerBusy  = false
let _stableCount = 0
let _detectStart = 0

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
<div style="display:grid;grid-template-columns:2fr 3fr;gap:16px;align-items:start">

  <!-- Left 2/5: instructions + form + list -->
  <div>

    <!-- Dynamic instructions -->
    <div class="card" id="cal-instructions">
      <div class="card-title">Instructions</div>
      <div id="cal-instr-body"></div>
    </div>

    <!-- New Calibration Profile -->
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
          <button class="toggle-chip"        id="cal-method-checkerboard" data-method="checkerboard">Checkerboard</button>
          <button class="toggle-chip"        id="cal-method-charuco"      data-method="charuco">ChArUco</button>
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
        <button class="btn btn-ghost btn-sm" id="cal-print-checker" style="margin-bottom:10px">
          ⬇ Download Checkerboard PDF
        </button>
      </div>

      <!-- ── ChArUco fields ── -->
      <div id="cal-charuco-fields" class="hidden">
        <div class="form-row-inline">
          <div>
            <label>Grid Cols</label>
            <input type="number" id="cal-charuco-cols" value="7" min="4" max="20" />
          </div>
          <div>
            <label>Grid Rows</label>
            <input type="number" id="cal-charuco-rows" value="5" min="3" max="20" />
          </div>
          <div>
            <label>Square size (mm)</label>
            <input type="number" id="cal-charuco-sq" value="30" min="1" max="200" step="0.5" />
          </div>
        </div>
        <button class="btn btn-ghost btn-sm" id="cal-print-charuco" style="margin-bottom:10px">
          ⬇ Download ChArUco PDF
        </button>
      </div>

      <!-- Shared board detection status + controls (visible in checkerboard/charuco modes) -->
      <div id="cal-board-controls" class="hidden">
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

  <!-- Right 3/5: camera preview -->
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

  // Board auto-detect
  container.querySelector('#cal-detect-btn').addEventListener('click', () => startDetection(container))
  container.querySelector('#cal-stop-detect-btn').addEventListener('click', () => stopDetection(container))

  // PDF downloads
  container.querySelector('#cal-print-checker').addEventListener('click', async (e) => {
    const btn = e.currentTarget
    const cols   = parseInt(container.querySelector('#cal-cols').value) || 9
    const rows   = parseInt(container.querySelector('#cal-rows').value) || 6
    const sqMm   = parseFloat(container.querySelector('#cal-square-mm').value) || 20
    btn.textContent = '⏳ Generating…'; btn.disabled = true
    try { await downloadCheckerboard(cols, rows, sqMm) }
    catch (err) { alert('PDF generation failed: ' + err.message) }
    finally { btn.textContent = '⬇ Download Checkerboard PDF'; btn.disabled = false }
  })

  container.querySelector('#cal-print-charuco').addEventListener('click', async (e) => {
    const btn = e.currentTarget
    const cols = parseInt(container.querySelector('#cal-charuco-cols').value) || 7
    const rows = parseInt(container.querySelector('#cal-charuco-rows').value) || 5
    const sqMm = parseFloat(container.querySelector('#cal-charuco-sq').value) || 30
    btn.textContent = '⏳ Generating…'; btn.disabled = true
    try { await downloadCharucoBoard(cols, rows, sqMm) }
    catch (err) { alert('PDF generation failed: ' + err.message) }
    finally { btn.textContent = '⬇ Download ChArUco PDF'; btn.disabled = false }
  })
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

  const rulerFields   = container.querySelector('#cal-ruler-fields')
  const cbFields      = container.querySelector('#cal-cb-fields')
  const charucoFields = container.querySelector('#cal-charuco-fields')
  const boardControls = container.querySelector('#cal-board-controls')

  rulerFields.classList.toggle('hidden',   method !== 'ruler')
  cbFields.classList.toggle('hidden',      method !== 'checkerboard')
  charucoFields.classList.toggle('hidden', method !== 'charuco')
  boardControls.classList.toggle('hidden', method === 'ruler')

  if (method === 'ruler') {
    overlayCanvas.style.cursor = 'crosshair'
    setInstructions(container, `
      <p style="font-size:13px;color:var(--text);margin-bottom:10px">
        Calibration can be performed with a ruler or an object of known length.
        You can also use the Checkerboard or ChArUco automated methods —
        print the board PDF from those tabs.
      </p>
      <ol style="padding-left:16px;line-height:2;font-size:13px;color:var(--text-muted)">
        <li>Start the camera.</li>
        <li>Place a ruler or object of known length flat in the scene where the subject will move.</li>
        <li><strong>Click 2 points</strong> on the preview — e.g. the 0 cm and 10 cm marks.</li>
        <li>Enter the real distance between those two points and choose <em>mm</em> or <em>inches</em>.</li>
        <li>Click <strong>Calculate</strong>, then <strong>Save Profile</strong>.</li>
      </ol>`)
  } else if (method === 'checkerboard') {
    overlayCanvas.style.cursor = 'default'
    setInstructions(container, `
      <ol style="padding-left:16px;line-height:2;font-size:13px;color:var(--text-muted)">
        <li>Download and print the checkerboard PDF (button below the config).</li>
        <li>Set Inner Cols, Inner Rows and Square Size to match your printout.</li>
        <li>Start the camera and click <strong>Start Detection</strong>.</li>
        <li>Hold the board flat and facing the camera.</li>
        <li>Once ${STABLE_FRAMES} stable detections are found, the scale is computed automatically.</li>
        <li>Click <strong>Save Profile</strong>.</li>
      </ol>
      <p style="font-size:11px;color:var(--text-muted);margin-top:8px">
        ⚠ OpenCV.js (~10 MB) loads in the background on first use.
      </p>`)
  } else {
    overlayCanvas.style.cursor = 'default'
    setInstructions(container, `
      <ol style="padding-left:16px;line-height:2;font-size:13px;color:var(--text-muted)">
        <li>Download and print the ChArUco PDF (button below the config).</li>
        <li>Set Grid Cols, Grid Rows and Square Size to match your printout.</li>
        <li>Start the camera and click <strong>Start Detection</strong>.</li>
        <li>Hold the board facing the camera — partial visibility is OK.</li>
        <li>Once ${STABLE_FRAMES} stable detections are found, the scale is computed automatically.</li>
        <li>Click <strong>Save Profile</strong>.</li>
      </ol>
      <p style="font-size:11px;color:var(--text-muted);margin-top:8px">
        ChArUco boards are more robust than plain checkerboards — each corner has a unique marker ID,
        so partial occlusion is handled gracefully.
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

// ── Board auto-detection (Web Worker) ────────────────────────
//
// Uses calib-worker.js which supports:
//   'detect'        → checkerboard (OpenCV cornerSubPix)
//   'detect-charuco' → ChArUco (js-aruco2 + homography)
//
// After STABLE_FRAMES consecutive detections the px/mm scale is
// computed from the average inter-corner pixel spacing and displayed.

function startDetection(container) {
  if (!videoEl.srcObject) { alert('Start the camera first.'); return }

  _stableCount = 0
  _detectStart = Date.now()
  detecting    = true
  _workerBusy  = false

  setDetectStatus(container, 'loading', 'Loading OpenCV.js…')
  container.querySelector('#cal-detect-btn').disabled      = true
  container.querySelector('#cal-stop-detect-btn').disabled = false

  _worker = new Worker(`${import.meta.env.BASE_URL}vendor/calib-worker.js`)

  _worker.onerror = () => {
    setDetectStatus(container, 'error', 'Worker failed to load. Please reload and try again.')
    container.querySelector('#cal-detect-btn').disabled      = false
    container.querySelector('#cal-stop-detect-btn').disabled = true
    detecting = false
    _worker = null
  }

  _worker.onmessage = (e) => {
    const { type, corners, ids } = e.data
    _workerBusy = false
    if (!detecting) return

    if (type === 'result' || type === 'charuco-result') {
      _stableCount++
      drawCornersOverlay(corners)
      setDetectStatus(container, 'found',
        `✔ Board detected (${_stableCount} frame${_stableCount > 1 ? 's' : ''}) — ${corners.length} corners`)

      if (_stableCount >= STABLE_FRAMES) {
        const pxPerMm = type === 'charuco-result'
          ? computePxPerMmCharuco(corners, ids, getCols(container), getSquareMm(container))
          : computePxPerMmChecker(corners, getCols(container), getRows(container), getSquareMm(container))

        if (pxPerMm && pxPerMm > 0) {
          _lastPxPerMm = pxPerMm
          stopDetectionLoop()
          const cornerCount = corners.length
          setDetectStatus(container, 'ready',
            `✔ Scale computed from ${cornerCount} corners over ${_stableCount} frames.`)
          showResult(container, `
            <strong>Scale factor:</strong> ${pxPerMm.toFixed(4)} px/mm<br/>
            <span style="color:var(--text-muted);font-size:11px">
              Avg corner spacing: ${(pxPerMm * getSquareMm(container)).toFixed(1)} px → ${getSquareMm(container)} mm
              (${calMethod === 'charuco' ? 'ChArUco' : 'Checkerboard'})
            </span>`)
          container.querySelector('#cal-detect-btn').disabled      = false
          container.querySelector('#cal-stop-detect-btn').disabled = true
        }
      }
    } else {
      // 'miss' — board not found or worker still initializing
      _stableCount = 0
      ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height)
      const elapsed = Date.now() - _detectStart
      const boardName = calMethod === 'charuco' ? 'ChArUco board' : 'checkerboard'
      setDetectStatus(container, 'scanning',
        elapsed < 5000 ? 'Loading OpenCV.js…' : `Scanning for ${boardName}…`)
    }
  }

  function loop() {
    if (!detecting) return
    detectRAF = requestAnimationFrame(loop)
    if (_workerBusy || videoEl.readyState < 2) return

    const w = videoEl.videoWidth, h = videoEl.videoHeight
    const tmp = document.createElement('canvas')
    tmp.width = w; tmp.height = h
    tmp.getContext('2d').drawImage(videoEl, 0, 0)
    const imageData = tmp.getContext('2d').getImageData(0, 0, w, h)

    _workerBusy = true
    if (calMethod === 'charuco') {
      const cols = parseInt(container.querySelector('#cal-charuco-cols').value) || 7
      const rows = parseInt(container.querySelector('#cal-charuco-rows').value) || 5
      const squareMm = parseFloat(container.querySelector('#cal-charuco-sq').value) || 30
      _worker.postMessage(
        { type: 'detect-charuco', buffer: imageData.data.buffer, width: w, height: h,
          board: { cols, rows, squareMm }, camId: 0 },
        [imageData.data.buffer]
      )
    } else {
      const cols = parseInt(container.querySelector('#cal-cols').value) || 9
      const rows = parseInt(container.querySelector('#cal-rows').value) || 6
      _worker.postMessage(
        { type: 'detect', buffer: imageData.data.buffer, width: w, height: h,
          board: { cols, rows }, camId: 0 },
        [imageData.data.buffer]
      )
    }
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
  setDetectStatus(container, 'idle', 'Detection stopped.')
}

function stopDetectionLoop() {
  detecting = false
  if (detectRAF) { cancelAnimationFrame(detectRAF); detectRAF = null }
}

// ── Board config helpers ──────────────────────────────────────

function getCols(container) {
  return calMethod === 'charuco'
    ? parseInt(container.querySelector('#cal-charuco-cols').value) || 7
    : parseInt(container.querySelector('#cal-cols').value) || 9
}

function getRows(container) {
  return calMethod === 'charuco'
    ? parseInt(container.querySelector('#cal-charuco-rows').value) || 5
    : parseInt(container.querySelector('#cal-rows').value) || 6
}

function getSquareMm(container) {
  return calMethod === 'charuco'
    ? parseFloat(container.querySelector('#cal-charuco-sq').value) || 30
    : parseFloat(container.querySelector('#cal-square-mm').value) || 20
}

// ── pxPerMm from detected corners ────────────────────────────

function computePxPerMmChecker(corners, cols, rows, squareMm) {
  let total = 0, count = 0
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = corners[r * cols + c], b = corners[r * cols + c + 1]
      if (a && b) { total += Math.hypot(b[0]-a[0], b[1]-a[1]); count++ }
    }
  }
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols; c++) {
      const a = corners[r * cols + c], b = corners[(r+1) * cols + c]
      if (a && b) { total += Math.hypot(b[0]-a[0], b[1]-a[1]); count++ }
    }
  }
  return count > 0 ? (total / count) / squareMm : null
}

function computePxPerMmCharuco(corners, ids, gridCols, squareMm) {
  const innerCols = gridCols - 1
  const map = {}
  ids.forEach((id, i) => { map[id] = corners[i] })
  let total = 0, count = 0
  for (const id of ids) {
    const a = map[id]
    const ic = id % innerCols
    if (ic < innerCols - 1 && map[id+1]) {
      const b = map[id+1]
      total += Math.hypot(b[0]-a[0], b[1]-a[1]); count++
    }
    if (map[id + innerCols]) {
      const b = map[id + innerCols]
      total += Math.hypot(b[0]-a[0], b[1]-a[1]); count++
    }
  }
  return count > 0 ? (total / count) / squareMm : null
}

// ── Detection status + overlay ────────────────────────────────

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
  el.style.color       = colors[state] ?? 'var(--text-muted)'
  el.style.borderColor = state === 'found' || state === 'ready'
    ? 'rgba(62,207,112,.3)' : 'var(--border)'
  el.innerHTML = msg
}

function drawCornersOverlay(corners, color = '#3ecf70') {
  // corners: [[x,y], ...] — nested array from calib-worker.js
  const scaleX = overlayCanvas.width  / videoEl.videoWidth
  const scaleY = overlayCanvas.height / videoEl.videoHeight
  ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height)

  for (const [px, py] of corners) {
    ctx.beginPath()
    ctx.arc(px * scaleX, py * scaleY, 5, 0, Math.PI * 2)
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

  let meta
  if (calMethod === 'checkerboard') {
    meta = {
      squareSizeMm: parseFloat(container.querySelector('#cal-square-mm').value),
      checkCols:    parseInt(container.querySelector('#cal-cols').value),
      checkRows:    parseInt(container.querySelector('#cal-rows').value),
    }
  } else if (calMethod === 'charuco') {
    meta = {
      squareSizeMm: parseFloat(container.querySelector('#cal-charuco-sq').value),
      charucoCols:  parseInt(container.querySelector('#cal-charuco-cols').value),
      charucoRows:  parseInt(container.querySelector('#cal-charuco-rows').value),
    }
  } else {
    meta = {
      rulerDistMm: parseFloat(container.querySelector('#cal-ruler-unit').value === 'in'
        ? container.querySelector('#cal-ruler-dist').value * 25.4
        : container.querySelector('#cal-ruler-dist').value),
    }
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
    let methodBadge
    if (c.method === 'checkerboard') {
      methodBadge = `<span class="trial-badge" style="background:rgba(91,127,255,.2);color:var(--accent)">CB</span>`
    } else if (c.method === 'charuco') {
      methodBadge = `<span class="trial-badge" style="background:rgba(168,85,247,.2);color:#a855f7">ChArUco</span>`
    } else {
      methodBadge = `<span class="trial-badge" style="background:rgba(62,207,112,.2);color:var(--success)">Ruler</span>`
    }
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
