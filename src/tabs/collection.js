import { listCameras, listCamerasAfterPermission, openCamera, stopCamera, loadModel, detectFrame, drawResults } from '../utils/mediapipe.js'
import { VoiceController } from '../utils/voice.js'
import { getAllCalibrations, saveSession, getAllSessions, saveTrial, updateTrial, getTrialsBySession, getAllSessions as _gas, deleteSession, deleteTrial, downloadBlob, exportTrialCSV, getSession } from '../db.js'

// ── Core state ────────────────────────────────────────────────

let cameras      = []
let calibrations = []
let sessions     = []
let currentSession  = null
let currentTrials   = []

let videoEl       = null
let overlayCanvas = null
let ctx           = null
let landmarker    = null
let currentModel  = 'pose'
let activeStream  = null
let mediaRecorder = null
let recordedChunks = []

let isFlipped      = false
let isRecording    = false
let trialStartTime = 0
let trialDuration  = 30
let trialTimerId   = null
let animFrameId    = null
let currentLandmarkData = []
let currentTrialObj     = null
let selectedTrialId     = null

let voice          = null
let _onVoiceStatus = null
let _onCamStatus   = null

// ── 3D Landmark Plot state ─────────────────────────────────────

let _lastResult = null   // latest detectFrame result, read by 3D plot each frame
let _3dRAF      = null
let _3dCanvas   = null
let _3dCtx      = null
let _3dRotY     = 0.4   // current horizontal rotation angle (radians)
let _3dNow      = 0     // current RAF timestamp, used for pulse animations
let _3dSmooth   = null  // {cx, cy, cz, scale} — smoothed adaptive viewport
let _3dRO       = null  // ResizeObserver

// Document-level listeners stored so they can be removed on deactivate
let _3dDocMouseMove = null
let _3dDocMouseUp   = null
let _3dDocTouchMove = null
let _3dDocTouchEnd  = null

// Per-landmark color for hand model (wrist + thumb + 4 fingers × 4 joints)
const _HAND_COLORS = [
  '#94a3b8',
  '#fcd34d','#fbbf24','#f59e0b','#b45309',
  '#86efac','#4ade80','#22c55e','#15803d',
  '#93c5fd','#60a5fa','#3b82f6','#1d4ed8',
  '#d8b4fe','#c084fc','#a855f7','#7c3aed',
  '#67e8f9','#22d3ee','#06b6d4','#0e7490',
]

const _HAND_CONN = [
  [0,1],[1,2],[2,3],[3,4],
  [0,5],[5,6],[6,7],[7,8],
  [0,9],[9,10],[10,11],[11,12],
  [0,13],[13,14],[14,15],[15,16],
  [0,17],[17,18],[18,19],[19,20],
  [5,9],[9,13],[13,17],
]

const _POSE_CONN = [
  [0,1],[1,2],[2,3],[3,7],[0,4],[4,5],[5,6],[6,8],
  [9,10],[11,12],
  [11,13],[13,15],[15,17],[15,19],[17,19],[15,21],
  [12,14],[14,16],[16,18],[16,20],[18,20],[16,22],
  [11,23],[12,24],[23,24],
  [23,25],[25,27],[27,29],[27,31],[29,31],
  [24,26],[26,28],[28,30],[28,32],[30,32],
]

function _poseColor(i) {
  if (i <= 10) return '#94a3b8'
  if ([11,13,15,17,19,21].includes(i)) return '#4ade80'
  if ([12,14,16,18,20,22].includes(i)) return '#fb923c'
  if ([23,24].includes(i)) return '#5b7fff'
  if ([25,27,29,31].includes(i)) return '#a78bfa'
  if ([26,28,30,32].includes(i)) return '#22d3ee'
  return '#94a3b8'
}

// ── 3D rendering helpers ──────────────────────────────────────

function _hex2rgba(hex, a) {
  const r = parseInt(hex.slice(1,3),16)
  const g = parseInt(hex.slice(3,5),16)
  const b = parseInt(hex.slice(5,7),16)
  return `rgba(${r},${g},${b},${a.toFixed(2)})`
}

function _project3D(x, y, z, cx, cy, cz, scale, rotY, W, H) {
  const lx = (x - cx) * scale
  const ly = -(y - cy) * scale   // negate: MediaPipe y increases downward
  const lz = (z - cz) * scale

  // Rotate around Y axis (auto-spin)
  const cosY = Math.cos(rotY), sinY = Math.sin(rotY)
  const rx = lx * cosY + lz * sinY
  const rz = -lx * sinY + lz * cosY

  // Tilt: rotate around X axis to look from slightly above
  const tilt = -0.45
  const cosX = Math.cos(tilt), sinX = Math.sin(tilt)
  const ry   = ly * cosX - rz * sinX
  const rz2  = ly * sinX + rz * cosX

  // Perspective divide
  const near  = Math.max(W, H) * 1.4
  const persp = near / (near + rz2)

  return { sx: W / 2 + rx * persp, sy: H / 2 - ry * persp, depth: rz2, persp }
}

function _adaptViewport(pts, W, H) {
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y), zs = pts.map(p => p.z ?? 0)
  const cx = (Math.max(...xs) + Math.min(...xs)) / 2
  const cy = (Math.max(...ys) + Math.min(...ys)) / 2
  const cz = (Math.max(...zs) + Math.min(...zs)) / 2
  const range = Math.max(
    Math.max(...xs) - Math.min(...xs),
    Math.max(...ys) - Math.min(...ys),
    Math.max(...zs) - Math.min(...zs),
    1e-4
  )
  return { cx, cy, cz, scale: Math.min(W, H) * 0.40 / range }
}

function _smoothViewport(target) {
  if (!_3dSmooth) { _3dSmooth = { ...target }; return }
  const a = 0.07
  _3dSmooth.cx    += (target.cx    - _3dSmooth.cx)    * a
  _3dSmooth.cy    += (target.cy    - _3dSmooth.cy)    * a
  _3dSmooth.cz    += (target.cz    - _3dSmooth.cz)    * a
  _3dSmooth.scale += (target.scale - _3dSmooth.scale) * a
}

function _drawStage(ctx, W, H) {
  const cx = W / 2, cy = H * 0.8
  const rx = Math.min(W, H) * 0.36, ry = rx * 0.16
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rx)
  g.addColorStop(0, 'rgba(91,127,255,0.10)')
  g.addColorStop(1, 'rgba(91,127,255,0)')
  ctx.save()
  ctx.beginPath()
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2)
  ctx.fillStyle = g
  ctx.fill()
  ctx.restore()
}

function _drawConnections3D(ctx, proj, conns, colors) {
  for (const [a, b] of conns) {
    if (!proj[a] || !proj[b]) continue
    const pa = proj[a], pb = proj[b]
    const alpha = Math.max(0.12, 0.55 - (pa.depth + pb.depth) * 0.0006)
    const col   = colors[a] ?? '#5b7fff'
    ctx.beginPath()
    ctx.moveTo(pa.sx, pa.sy)
    ctx.lineTo(pb.sx, pb.sy)
    ctx.strokeStyle = _hex2rgba(col, alpha)
    ctx.lineWidth   = Math.max(0.5, 1.3 * pa.persp)
    ctx.stroke()
  }
}

function _drawDots3D(ctx, proj, colors, tipIndices) {
  // Painter's algorithm: draw far points first so near points appear on top
  const order = proj.map((p, i) => ({ ...p, i })).sort((a, b) => b.depth - a.depth)
  for (const { sx, sy, depth, persp, i } of order) {
    const col   = colors[i] ?? '#5b7fff'
    const isTip = tipIndices.includes(i)
    const pulse = isTip ? 1 + 0.14 * Math.sin(_3dNow * 0.003 + i) : 1
    const r     = (isTip ? 5.5 : 3.5) * Math.max(0.55, persp) * pulse
    const alpha = Math.max(0.45, Math.min(1, 0.85 - depth * 0.0007))

    ctx.shadowColor = col
    ctx.shadowBlur  = isTip ? 9 : 5
    ctx.beginPath()
    ctx.arc(sx, sy, r, 0, Math.PI * 2)
    ctx.fillStyle = _hex2rgba(col, alpha)
    ctx.fill()
  }
  ctx.shadowBlur = 0
}

function _drawPlaceholder3D(ctx, W, H) {
  const cx = W / 2, cy = H * 0.42
  const pulse = (Math.sin(_3dNow * 0.0015) + 1) / 2
  const unit  = Math.min(W, H) * 0.09
  for (let r = 1; r <= 3; r++) {
    const rad = r * unit + pulse * unit * 0.35
    const a   = (0.18 - r * 0.03) * (0.5 + pulse * 0.5)
    ctx.beginPath()
    ctx.arc(cx, cy, rad, 0, Math.PI * 2)
    ctx.strokeStyle = `rgba(91,127,255,${a.toFixed(3)})`
    ctx.lineWidth   = 1
    ctx.stroke()
  }
  ctx.fillStyle    = 'rgba(136,146,164,0.38)'
  ctx.font         = `${Math.max(8, Math.round(W * 0.055))}px system-ui, sans-serif`
  ctx.textAlign    = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('No landmarks', cx, cy + H * 0.22)
}

function _draw3DScene() {
  if (!_3dCanvas || !_3dCtx) return
  const ctx = _3dCtx, W = _3dCanvas.width, H = _3dCanvas.height

  // Semi-transparent background — lets the camera feed show through
  ctx.clearRect(0, 0, W, H)
  ctx.fillStyle = 'rgba(10,14,24,0.65)'
  ctx.fillRect(0, 0, W, H)

  const result = _lastResult
  const model  = currentModel

  // Collect point sets (one per hand for hands model, one total for pose/face)
  let pointSets = []
  if (model === 'hands') {
    const all = result?.allHands ?? (result ? [result] : [])
    for (const hand of all) {
      const pts = hand.worldLandmarks ?? hand.landmarks
      if (pts?.length) pointSets.push({ pts, label: hand.handedness ?? '' })
    }
  } else if (result) {
    const pts = result.worldLandmarks ?? result.landmarks
    if (pts?.length) pointSets.push({ pts, label: '' })
  }

  if (!pointSets.length) {
    _drawPlaceholder3D(ctx, W, H)
    return
  }

  // Adaptive viewport, smoothed to avoid jumpy scale/center
  _smoothViewport(_adaptViewport(pointSets.flatMap(s => s.pts), W, H))
  const { cx, cy, cz, scale } = _3dSmooth

  // Soft stage glow beneath landmarks
  _drawStage(ctx, W, H)

  for (let hi = 0; hi < pointSets.length; hi++) {
    const { pts, label } = pointSets[hi]
    const proj = pts.map(p => _project3D(p.x, p.y, p.z ?? 0, cx, cy, cz, scale, _3dRotY, W, H))

    ctx.save()

    if (model === 'face') {
      // 478 dots: batch-render without per-dot glow for performance
      ctx.beginPath()
      for (const { sx, sy } of proj) { ctx.moveTo(sx + 1.5, sy); ctx.arc(sx, sy, 1.5, 0, Math.PI * 2) }
      ctx.fillStyle = 'rgba(147,197,253,0.65)'
      ctx.fill()
    } else {
      const colors = model === 'hands'
        ? _HAND_COLORS
        : pts.map((_, i) => _poseColor(i))
      const conns = model === 'hands' ? _HAND_CONN : _POSE_CONN
      const tips  = model === 'hands' ? [4, 8, 12, 16, 20] : [15, 16, 27, 28]
      _drawConnections3D(ctx, proj, conns, colors)
      _drawDots3D(ctx, proj, colors, tips)
    }

    // Hand label (L / R)
    if (model === 'hands' && label) {
      const n = proj.length
      const avgX = proj.reduce((s, p) => s + p.sx, 0) / n
      const avgY = proj.reduce((s, p) => s + p.sy, 0) / n
      ctx.fillStyle    = 'rgba(148,163,184,0.55)'
      ctx.font         = 'bold 11px system-ui, sans-serif'
      ctx.textAlign    = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(label[0], avgX, avgY - 32)
    }

    ctx.restore()
  }

  // Bottom-left coordinate system note
  ctx.save()
  ctx.fillStyle    = 'rgba(88,100,125,0.55)'
  ctx.font         = `${Math.max(7, Math.round(W * 0.048))}px system-ui, sans-serif`
  ctx.textAlign    = 'left'
  ctx.textBaseline = 'bottom'
  const coordNote = (model === 'pose' || model === 'hands') ? 'world (m)' : 'norm'
  ctx.fillText(`3D · ${coordNote}`, 5, H - 4)
  ctx.restore()
}

function _init3DPlot(container) {
  _3dCanvas = container.querySelector('#col-3d-canvas')
  if (!_3dCanvas) return
  _3dCtx    = _3dCanvas.getContext('2d')
  _3dSmooth = null

  const wrap    = container.querySelector('#col-3d-wrap')
  const camWrap = container.querySelector('#col-camera-wrap')
  const resizeH = container.querySelector('#col-3d-resize')

  // Size canvas buffer to match the wrapper div
  const setSize = () => {
    const w = wrap?.offsetWidth  ?? 0
    const h = wrap?.offsetHeight ?? 0
    if (w > 0 && h > 0 && (_3dCanvas.width !== w || _3dCanvas.height !== h)) {
      _3dCanvas.width  = w
      _3dCanvas.height = h
      _3dSmooth = null
    }
  }

  // Initial size: overlay ~half the camera's height, 16:9 aspect
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (wrap && !wrap.dataset.sized) {
      wrap.dataset.sized = '1'
      const camH = camWrap?.offsetHeight ?? 0
      if (camH > 0) {
        const h = Math.round(camH * 0.5)
        const w = Math.round(h * 16 / 9)
        wrap.style.width  = w + 'px'
        wrap.style.height = h + 'px'
        setSize()
      }
    }
  }))

  setSize()
  if (window.ResizeObserver) {
    _3dRO = new ResizeObserver(setSize)
    _3dRO.observe(wrap ?? _3dCanvas)
  }

  // ── Drag to move / corner to resize ────────────────────────
  let dragMode = null   // 'move' | 'resize'
  let ox = 0, oy = 0, startL = 0, startT = 0, startW = 0, startH = 0

  function onStart(clientX, clientY, mode) {
    dragMode = mode
    ox = clientX; oy = clientY
    const wr = camWrap.getBoundingClientRect()
    const cr = wrap.getBoundingClientRect()
    startL = cr.left - wr.left
    startT = cr.top  - wr.top
    startW = wrap.offsetWidth
    startH = wrap.offsetHeight
    // Convert right/bottom anchoring to explicit left/top so offset math works
    wrap.style.right  = 'auto'
    wrap.style.bottom = 'auto'
    wrap.style.left   = startL + 'px'
    wrap.style.top    = startT + 'px'
  }

  function onMove(clientX, clientY) {
    if (!dragMode) return
    const dx = clientX - ox, dy = clientY - oy
    const wr = camWrap.getBoundingClientRect()
    if (dragMode === 'move') {
      const l = Math.max(0, Math.min(wr.width  - wrap.offsetWidth,  startL + dx))
      const t = Math.max(0, Math.min(wr.height - wrap.offsetHeight, startT + dy))
      wrap.style.left = l + 'px'
      wrap.style.top  = t + 'px'
    } else {
      wrap.style.width  = Math.min(Math.max(100, startW + dx), wr.width  - startL) + 'px'
      wrap.style.height = Math.min(Math.max(70,  startH + dy), wr.height - startT) + 'px'
    }
  }

  wrap.addEventListener('mousedown', e => { onStart(e.clientX, e.clientY, 'move');   e.preventDefault() })
  resizeH?.addEventListener('mousedown', e => { onStart(e.clientX, e.clientY, 'resize'); e.preventDefault(); e.stopPropagation() })

  wrap.addEventListener('touchstart', e => { onStart(e.touches[0].clientX, e.touches[0].clientY, 'move');   e.preventDefault() }, { passive: false })
  resizeH?.addEventListener('touchstart', e => { onStart(e.touches[0].clientX, e.touches[0].clientY, 'resize'); e.preventDefault(); e.stopPropagation() }, { passive: false })

  _3dDocMouseMove = e => onMove(e.clientX, e.clientY)
  _3dDocMouseUp   = () => { dragMode = null }
  _3dDocTouchMove = e => { if (dragMode) { onMove(e.touches[0].clientX, e.touches[0].clientY); e.preventDefault() } }
  _3dDocTouchEnd  = () => { dragMode = null }

  document.addEventListener('mousemove', _3dDocMouseMove)
  document.addEventListener('mouseup',   _3dDocMouseUp)
  document.addEventListener('touchmove', _3dDocTouchMove, { passive: false })
  document.addEventListener('touchend',  _3dDocTouchEnd)

  let lastTs = 0
  const loop = (ts) => {
    _3dRAF = requestAnimationFrame(loop)
    _3dNow = ts
    const dt = Math.min((ts - lastTs) / 1000, 0.05)
    lastTs = ts
    _3dRotY += 0.22 * dt
    _draw3DScene()
  }
  _3dRAF = requestAnimationFrame(loop)
}

function _stop3DLoop() {
  if (_3dRAF) { cancelAnimationFrame(_3dRAF); _3dRAF = null }
  if (_3dRO)  { _3dRO.disconnect(); _3dRO = null }
  if (_3dDocMouseMove) { document.removeEventListener('mousemove',  _3dDocMouseMove); _3dDocMouseMove = null }
  if (_3dDocMouseUp)   { document.removeEventListener('mouseup',    _3dDocMouseUp);   _3dDocMouseUp   = null }
  if (_3dDocTouchMove) { document.removeEventListener('touchmove',  _3dDocTouchMove); _3dDocTouchMove = null }
  if (_3dDocTouchEnd)  { document.removeEventListener('touchend',   _3dDocTouchEnd);  _3dDocTouchEnd  = null }
}

// ── Entry point ───────────────────────────────────────────────

export async function initCollection(container, { onVoiceStatus, onCamStatus }) {
  _onVoiceStatus = onVoiceStatus
  _onCamStatus   = onCamStatus
  container.innerHTML = buildUI()
  await mountRefs(container)
  await refreshSelects(container)
  bindEvents(container)
  initVoice(container)
  _init3DPlot(container)
}

// ── UI ────────────────────────────────────────────────────────

function buildUI() {
  return `
<div style="display:grid;grid-template-columns:1fr 2fr;gap:16px;align-items:start">

  <!-- Left 1/3: session + recording controls -->
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
          <input type="number" id="col-duration" value="30" min="1" max="300" style="width:72px" />
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

  <!-- Right 2/3: camera + 3D plot + voice -->
  <div>

    <!-- Live camera preview -->
    <div class="card">
      <div class="card-title" style="display:flex;align-items:center;justify-content:space-between">
        <span>Live Preview</span>
        <button id="col-mini-voice-btn" title="Toggle voice control" style="
          background:none;border:1px solid var(--border);border-radius:20px;
          padding:2px 10px 2px 6px;cursor:pointer;font-size:11px;
          color:var(--text-muted);display:flex;align-items:center;gap:4px;line-height:1.5;
          transition:border-color .15s,color .15s">
          <span id="col-mini-voice-icon">🎙️</span>
          <span id="col-mini-voice-label">Voice off</span>
        </button>
      </div>

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

        <!-- 3D landmark overlay: drag body to move, drag corner handle to resize -->
        <div id="col-3d-wrap" style="
          position:absolute;top:8px;right:8px;
          min-width:100px;min-height:70px;
          border-radius:8px;overflow:hidden;
          border:1px solid rgba(91,127,255,0.25);
          cursor:move;z-index:3;user-select:none">
          <canvas id="col-3d-canvas" style="
            width:100%;height:100%;display:block;
            pointer-events:none"></canvas>
          <div id="col-3d-resize" style="
            position:absolute;bottom:0;right:0;width:20px;height:20px;
            cursor:se-resize;z-index:4;
            background:linear-gradient(135deg,transparent 40%,rgba(91,127,255,0.55) 40%)">
          </div>
        </div>

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

      <div id="col-voice-cmds" style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px">
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

      <div style="font-size:11px;color:var(--text-muted)">
        Last heard: <span id="col-voice-last" style="color:var(--text);font-style:italic">—</span>
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

  // Model switching — cannot change mid-trial
  container.querySelector('#col-model-sel').addEventListener('change', (e) => {
    if (isRecording) {
      e.target.value = currentModel
      setStatus(container, 'Stop the current trial before switching models.')
      return
    }
    if (!videoEl.srcObject) {
      currentModel = e.target.value
      return
    }
    switchModel(container, e.target.value)
  })

  container.querySelector('#col-flip-btn').addEventListener('click', () => {
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

  const toggleVoice = () => {
    if (!voice.supported) {
      alert('Speech recognition is not supported in this browser. Use Chrome or Edge.')
      return
    }
    voice.toggle()
  }

  container.querySelector('#col-voice-toggle').addEventListener('click', toggleVoice)
  container.querySelector('#col-mini-voice-btn')?.addEventListener('click', toggleVoice)

  // Auto-start voice — browser will prompt for microphone permission
  if (voice.supported) voice.toggle()
}

// Update the voice panel to reflect current voice + recording state
function updateVoiceUI(container, voiceStatus) {
  const hint      = container.querySelector('#col-voice-command-hint')
  const mic       = container.querySelector('#col-voice-mic')
  const banner    = container.querySelector('#col-voice-state-banner')
  const cmdStart  = container.querySelector('#col-cmd-start')
  const cmdStop   = container.querySelector('#col-cmd-stop')
  const miniIcon  = container.querySelector('#col-mini-voice-icon')
  const miniLabel = container.querySelector('#col-mini-voice-label')
  const miniBtn   = container.querySelector('#col-mini-voice-btn')
  if (!hint) return

  const listening = voiceStatus === 'listening'

  // Sync mini button in Live Preview header
  if (miniIcon && miniLabel && miniBtn) {
    if (!listening) {
      miniIcon.textContent  = '🎙️'
      miniLabel.textContent = voiceStatus === 'error' ? 'Denied' : 'Voice off'
      miniBtn.style.borderColor = voiceStatus === 'error' ? 'var(--danger)' : 'var(--border)'
      miniBtn.style.color       = voiceStatus === 'error' ? 'var(--danger)' : 'var(--text-muted)'
    } else if (isRecording) {
      miniIcon.textContent  = '🔴'
      miniLabel.textContent = 'Listening'
      miniBtn.style.borderColor = 'var(--danger)'
      miniBtn.style.color       = 'var(--danger)'
    } else {
      miniIcon.textContent  = '🟢'
      miniLabel.textContent = 'Listening'
      miniBtn.style.borderColor = 'var(--success)'
      miniBtn.style.color       = 'var(--success)'
    }
  }

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
  el.style.color   = isError ? '#ef4444' : '#e2e8f0'
  el.innerHTML     = msg
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
    activeStream = await openCamera(deviceId, videoEl)
    _onCamStatus?.('active')
    setCamOverlay(container, '')

    cameras = await listCamerasAfterPermission()
    const activeId = activeStream.getVideoTracks()[0]?.getSettings?.()?.deviceId ?? ''
    camSel.innerHTML = cameras.map(c =>
      `<option value="${c.deviceId}" ${c.deviceId === activeId ? 'selected' : ''}>${c.label}</option>`
    ).join('')

    setStatus(container, 'Loading MediaPipe model — first load may take 10–30 s…')
    setCamOverlay(container, '⏳ Loading MediaPipe model…<br/><small style="color:#8892a4">First load: ~10–30 s</small>')
    landmarker = await loadModel(model)
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
    _onCamStatus?.('error')
    startBtn.disabled    = false
    startBtn.textContent = '▶ Start Camera'
  }
}

function friendlyError(err) {
  const name = err.name ?? ''
  if (name === 'NotAllowedError')      return 'Camera permission denied. Allow access in browser settings and try again.'
  if (name === 'NotFoundError')        return 'No camera found. Connect a camera and try again.'
  if (name === 'NotReadableError')     return 'Camera is in use by another app. Close other apps and try again.'
  if (name === 'OverconstrainedError') return 'Selected camera could not be opened. Try a different camera.'
  if (err.message?.includes('Vision not initialized')) return 'MediaPipe failed to load. Check the status bar and reload the page.'
  return err.message ?? 'Unknown error'
}

const MODEL_LABELS = { pose: 'Pose (Full Body)', hands: 'Hands', face: 'Face' }

async function switchModel(container, model) {
  stopRenderLoop()
  _lastResult = null
  _3dSmooth   = null
  ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height)
  const label = MODEL_LABELS[model] ?? model
  setCamOverlay(container, `⏳ Switching to ${label} model…<br/><small style="color:#8892a4">First load: ~10–30 s</small>`)
  setStatus(container, 'Switching model…')
  container.querySelector('#col-start-trial').disabled = true

  try {
    landmarker   = await loadModel(model)
    currentModel = model
    setCamOverlay(container, '')
    setStatus(container, `Model switched to ${label}.`)
    if (currentSession) container.querySelector('#col-start-trial').disabled = false
    startRenderLoop(container)
  } catch (err) {
    const msg = friendlyError(err)
    setCamOverlay(container, `⚠ ${msg}`, true)
    setStatus(container, msg)
    container.querySelector('#col-model-sel').value = currentModel
  }
}

function stopCameraFn(container) {
  stopRenderLoop()
  _lastResult = null
  _3dSmooth   = null
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
    _lastResult = result   // feed the live 3D plot

    if (isRecording && result) {
      const copyLm  = lm => ({ x: lm.x, y: lm.y, z: lm.z, visibility: lm.visibility ?? 0 })
      const copyWLm = lm => ({ x: lm.x, y: lm.y, z: lm.z })
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

      const elapsed   = (nowMs - trialStartTime) / 1000
      const pct       = Math.min(elapsed / trialDuration * 100, 100)
      const remaining = Math.max(0, trialDuration - elapsed)
      const mins = Math.floor(remaining / 60)
      const secs = Math.floor(remaining % 60).toString().padStart(2, '0')
      const timerEl = container.querySelector('#col-timer')
      if (timerEl) timerEl.textContent = `${mins}:${secs}`
      const progEl  = container.querySelector('#col-progress')
      if (progEl)   progEl.style.width = `${pct}%`
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
  container.querySelector('#col-session-name').value  = ''
  container.querySelector('#col-session-notes').value = ''

  await refreshSelects(container)
  container.querySelector('#col-session-sel').value = id
  await selectSession(container, id)
}

async function selectSession(container, id) {
  if (!id) { currentSession = null; return }
  currentSession = sessions.find(s => s.id === id) ?? await getSession(id)
  container.querySelector('#col-del-session').disabled    = false
  container.querySelector('#col-start-trial').disabled    = !videoEl.srcObject
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
  currentTrials  = []
  await refreshSelects(container)
  renderTrialList(container)
  container.querySelector('#col-del-session').disabled    = true
  container.querySelector('#col-start-trial').disabled    = true
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

  isRecording         = true
  trialStartTime      = performance.now()
  currentLandmarkData = []

  recordedChunks = []
  try {
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
      ? 'video/webm;codecs=vp9' : 'video/webm'
    mediaRecorder = new MediaRecorder(activeStream, { mimeType })
    mediaRecorder.ondataavailable = e => { if (e.data.size) recordedChunks.push(e.data) }
    mediaRecorder.start(250)
  } catch (_) {
    mediaRecorder = null
  }

  const trialId = await saveTrial({
    sessionId:     currentSession.id,
    name:          trialName,
    taskDesc,
    model:         currentModel,
    calibrationId: currentSession.calibrationId ?? null,
    startTime:     Date.now(),
    endTime:       null,
    duration:      null,
    landmarkData:  [],
    videoBlob:     null,
  })
  currentTrialObj = { id: trialId, name: trialName, taskDesc }

  container.querySelector('#col-rec-badge').classList.add('show')
  container.querySelector('#col-timer').classList.remove('hidden')
  container.querySelector('#col-start-trial').disabled = true
  container.querySelector('#col-stop-trial').disabled  = false
  nameInput.value = ''
  setStatus(container, `Recording "${trialName}"…`)
  if (voice?.active) updateVoiceUI(container, 'listening')

  trialTimerId = setTimeout(() => stopTrial(container), trialDuration * 1000)
}

async function stopTrial(container) {
  if (!isRecording) return
  clearTimeout(trialTimerId)
  isRecording = false

  const endTime  = performance.now()
  const duration = (endTime - trialStartTime) / 1000

  let videoBlob = null
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    await new Promise(resolve => {
      mediaRecorder.onstop = resolve
      mediaRecorder.stop()
    })
    videoBlob = new Blob(recordedChunks, { type: 'video/webm' })
  }

  if (currentTrialObj) {
    await updateTrial({
      ...currentTrialObj,
      sessionId:     currentSession.id,
      taskDesc:      currentTrialObj.taskDesc,
      model:         currentModel,
      calibrationId: currentSession.calibrationId ?? null,
      startTime:     Date.now() - duration * 1000,
      endTime:       Date.now(),
      duration,
      landmarkData:  currentLandmarkData,
      videoBlob,
    })
  }

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
    const isRec    = t.id === currentTrialObj?.id
    const isSel    = t.id === selectedTrialId
    const hasVideo = !!t.videoBlob
    const hasLm    = (t.landmarkData?.length ?? 0) > 0
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

  listEl.querySelectorAll('[data-trial-id]').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.closest('button')) return
      const id = parseInt(row.dataset.trialId)
      selectedTrialId = (selectedTrialId === id) ? null : id
      renderTrialList(container)
    })
  })

  listEl.querySelectorAll('.dl-csv').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation()
      const trial = currentTrials.find(t => t.id === parseInt(btn.dataset.id))
      if (!trial) return
      const csv = exportTrialCSV(trial)
      if (csv) downloadBlob(new Blob([csv], { type: 'text/csv' }), `${currentSession.name}_${trial.name}.csv`)
      else alert('No landmark data found for this trial.')
    })
  })

  listEl.querySelectorAll('.dl-vid').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation()
      const trial = currentTrials.find(t => t.id === parseInt(btn.dataset.id))
      if (trial?.videoBlob) downloadBlob(trial.videoBlob, `${currentSession.name}_${trial.name}.webm`)
    })
  })

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

// ── Deactivate (called on tab switch) ────────────────────────

export function deactivateCollection() {
  if (isRecording) {
    clearTimeout(trialTimerId)
    isRecording = false
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop()
  }
  stopRenderLoop()
  _stop3DLoop()
  _lastResult = null
  stopCamera(videoEl)
  activeStream = null
  voice?.stop()
  _onVoiceStatus?.('off')

  const startBtn = document.querySelector('#col-start-cam')
  const stopBtn  = document.querySelector('#col-stop-cam')
  if (startBtn) { startBtn.disabled = false; startBtn.textContent = '▶ Start Camera' }
  if (stopBtn)   stopBtn.disabled = true
  const overlay = document.querySelector('#col-cam-overlay-msg')
  if (overlay) overlay.style.display = 'none'
}
