import {
  listCameras, listCamerasAfterPermission,
  openCamera, stopCamera, loadModel, detectFrame, drawResults,
} from '../utils/mediapipe.js'
import {
  scoreDeepSquat, scoreHurdleStep,
  toFMS, scoreColor, angle3pt, PhaseDetector,
} from '../utils/fms_scoring.js'

// ── Module state ──────────────────────────────────────────────

let cameras   = []
let videoEl   = null
let canvas    = null
let ctx       = null
let landmarker = null
let rafId     = null
let activeStream = null
let isFlipped = false

let selectedTest   = 'deep-squat'     // 'deep-squat' | 'hurdle-step'
let steppingLeg    = 'left'           // 'left' | 'right'

// Running scores: live (current frame) and peak (best since last reset)
let liveResult  = null
let peakResult  = null
let phaseDetector = null

// ── Entry point ───────────────────────────────────────────────

export async function initFMS(container) {
  container.innerHTML = buildUI()
  mountRefs(container)
  await populateCameras(container)
  bindEvents(container)
  phaseDetector = new PhaseDetector(selectedTest)
  renderScores(container, null, null)
}

export function deactivateFMS() {
  stopLoop()
  stopCamera(videoEl)
  activeStream = null
}

// ── UI builder ────────────────────────────────────────────────

function buildUI() {
  return `
<div style="display:grid;grid-template-columns:2fr 3fr;gap:16px;align-items:start">

  <!-- Left panel: controls + scoring -->
  <div>

    <!-- Test setup -->
    <div class="card">
      <div class="card-title">FMS Assessment</div>

      <div class="form-row">
        <label>Movement Test</label>
        <div class="toggle-group" id="fms-test-toggle">
          <button class="toggle-chip active" data-test="deep-squat">Deep Squat</button>
          <button class="toggle-chip"        data-test="hurdle-step">Hurdle Step</button>
        </div>
      </div>

      <!-- Hurdle step: which leg is stepping -->
      <div id="fms-leg-row" class="form-row hidden">
        <label>Stepping Leg</label>
        <div class="toggle-group" id="fms-leg-toggle">
          <button class="toggle-chip active" data-leg="left">Left</button>
          <button class="toggle-chip"        data-leg="right">Right</button>
        </div>
      </div>

      <div class="form-row">
        <label>Camera</label>
        <select id="fms-cam-select"></select>
      </div>

      <div class="btn-group mt-8">
        <button class="btn btn-primary btn-sm" id="fms-start-btn">▶ Start Camera</button>
        <button class="btn btn-ghost btn-sm"   id="fms-stop-btn"  disabled>■ Stop</button>
        <button class="btn btn-ghost btn-sm"   id="fms-flip-btn"  title="Mirror view">⇔</button>
        <button class="btn btn-ghost btn-sm"   id="fms-reset-btn" title="Reset peak score">↺ Reset Peak</button>
      </div>
    </div>

    <!-- Instructions -->
    <div class="card" id="fms-instructions">
      <div class="card-title">Instructions</div>
      <div id="fms-instr-body"></div>
    </div>

    <!-- Live + Peak scores -->
    <div class="card" id="fms-score-card">
      <div class="card-title">Scores</div>

      <!-- Phase indicator -->
      <div id="fms-phase" style="
        font-size:11px;color:var(--text-muted);
        padding:4px 10px;border-radius:20px;
        background:var(--surface2);border:1px solid var(--border);
        display:inline-block;margin-bottom:12px">
        Start camera to begin
      </div>

      <!-- Overall scores side by side -->
      <div style="display:flex;gap:12px;margin-bottom:14px">
        <div style="flex:1;text-align:center">
          <div style="font-size:10px;color:var(--text-muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:.04em">Live</div>
          <div id="fms-live-score" style="font-size:42px;font-weight:700;line-height:1;color:var(--text-muted)">—</div>
          <div id="fms-live-fms" style="font-size:11px;color:var(--text-muted);margin-top:3px">FMS —</div>
        </div>
        <div style="width:1px;background:var(--border)"></div>
        <div style="flex:1;text-align:center">
          <div style="font-size:10px;color:var(--text-muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:.04em">Peak</div>
          <div id="fms-peak-score" style="font-size:42px;font-weight:700;line-height:1;color:var(--text-muted)">—</div>
          <div id="fms-peak-fms" style="font-size:11px;color:var(--text-muted);margin-top:3px">FMS —</div>
        </div>
      </div>

      <!-- Criteria breakdown (peak) -->
      <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px">
        Criterion Breakdown (Peak)
      </div>
      <div id="fms-criteria"></div>

      <!-- Fine-grain comparison note -->
      <div style="margin-top:10px;font-size:10.5px;color:var(--text-muted);line-height:1.5">
        Score is continuous 0–100 (finer than FMS 0–3).
        <strong>67+</strong> = FMS&nbsp;3 &nbsp;·&nbsp;
        <strong>34–66</strong> = FMS&nbsp;2 &nbsp;·&nbsp;
        <strong>1–33</strong> = FMS&nbsp;1
      </div>
    </div>

  </div>

  <!-- Right panel: camera -->
  <div>
    <div class="card">
      <div class="card-title">Camera Preview</div>
      <div class="camera-wrap" id="fms-cam-wrap">
        <video id="fms-video" muted playsinline></video>
        <canvas id="fms-canvas"></canvas>
        <span class="camera-label" id="fms-cam-label">No camera</span>
      </div>
      <div style="margin-top:8px;font-size:11px;color:var(--text-muted)">
        Position subject so the full body is visible.
        For Deep Squat: front or 45° view.
        For Hurdle Step: front or side view.
      </div>
    </div>
  </div>

</div>`
}

// ── Mount refs ────────────────────────────────────────────────

function mountRefs(container) {
  videoEl = container.querySelector('#fms-video')
  canvas  = container.querySelector('#fms-canvas')
  ctx     = canvas.getContext('2d')

  videoEl.addEventListener('loadedmetadata', () => {
    canvas.width  = videoEl.videoWidth
    canvas.height = videoEl.videoHeight
  })
}

async function populateCameras(container) {
  cameras = await listCameras()
  const sel = container.querySelector('#fms-cam-select')
  sel.innerHTML = cameras.length
    ? cameras.map(c => `<option value="${c.deviceId}">${c.label}</option>`).join('')
    : '<option value="">No cameras found</option>'
}

// ── Events ────────────────────────────────────────────────────

function bindEvents(container) {
  container.querySelector('#fms-start-btn').addEventListener('click', () => startCamera(container))
  container.querySelector('#fms-stop-btn').addEventListener('click',  () => stopCameraFn(container))
  container.querySelector('#fms-flip-btn').addEventListener('click',  () => toggleFlip(container))
  container.querySelector('#fms-reset-btn').addEventListener('click', () => {
    peakResult = null
    phaseDetector?.reset()
    renderScores(container, liveResult, null)
  })

  container.querySelectorAll('[data-test]').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedTest = btn.dataset.test
      container.querySelectorAll('[data-test]').forEach(b =>
        b.classList.toggle('active', b.dataset.test === selectedTest))
      container.querySelector('#fms-leg-row').classList.toggle('hidden', selectedTest !== 'hurdle-step')
      peakResult = null
      phaseDetector = new PhaseDetector(selectedTest)
      setInstructions(container)
    })
  })

  container.querySelectorAll('[data-leg]').forEach(btn => {
    btn.addEventListener('click', () => {
      steppingLeg = btn.dataset.leg
      container.querySelectorAll('[data-leg]').forEach(b =>
        b.classList.toggle('active', b.dataset.leg === steppingLeg))
      peakResult = null
    })
  })

  setInstructions(container)
}

function setInstructions(container) {
  const body = container.querySelector('#fms-instr-body')
  if (selectedTest === 'deep-squat') {
    body.innerHTML = `
      <ol style="padding-left:16px;line-height:2;font-size:13px;color:var(--text-muted)">
        <li>Stand 2–3 m from the camera, full body visible.</li>
        <li>Hold a dowel (or arms) overhead, feet shoulder-width apart.</li>
        <li>Squat as deep as possible while keeping heels flat.</li>
        <li>Hold the bottom briefly, then stand back up.</li>
      </ol>
      <p style="font-size:11px;color:var(--text-muted);margin-top:6px">
        <strong>Peak score</strong> auto-captures at the deepest point.
        Repeat for a better score; click ↺&nbsp;Reset Peak to clear.
      </p>`
  } else {
    body.innerHTML = `
      <ol style="padding-left:16px;line-height:2;font-size:13px;color:var(--text-muted)">
        <li>Stand on one foot, hold a dowel (or arms) across shoulders.</li>
        <li>Step over an imaginary hurdle set at your tibial tuberosity height.</li>
        <li>Touch the heel lightly to the floor in front, then return.</li>
        <li>Select which leg is stepping above.</li>
      </ol>
      <p style="font-size:11px;color:var(--text-muted);margin-top:6px">
        <strong>Peak score</strong> auto-captures at the highest step point.
      </p>`
  }
}

// ── Camera ────────────────────────────────────────────────────

async function startCamera(container) {
  const sel      = container.querySelector('#fms-cam-select')
  const deviceId = sel.value

  if (!landmarker) {
    setPhase(container, 'Loading MediaPipe pose model…')
    try { landmarker = await loadModel('pose') }
    catch (err) { setPhase(container, 'Model load failed — reload page'); return }
  }

  try {
    activeStream = await openCamera(deviceId, videoEl)
    cameras = await listCamerasAfterPermission()
    const activeId = activeStream.getVideoTracks()[0]?.getSettings?.()?.deviceId ?? ''
    sel.innerHTML = cameras.map(c =>
      `<option value="${c.deviceId}" ${c.deviceId === activeId ? 'selected' : ''}>${c.label}</option>`
    ).join('')
    container.querySelector('#fms-cam-label').textContent =
      cameras.find(c => c.deviceId === activeId)?.label ?? 'Camera'
    container.querySelector('#fms-start-btn').disabled = true
    container.querySelector('#fms-stop-btn').disabled  = false
    startLoop(container)
    setPhase(container, 'Detecting pose…')
  } catch (err) {
    alert(`Camera error: ${err.message}`)
  }
}

function stopCameraFn(container) {
  stopLoop()
  stopCamera(videoEl)
  activeStream = null
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  container.querySelector('#fms-start-btn').disabled = false
  container.querySelector('#fms-stop-btn').disabled  = true
  setPhase(container, 'Camera stopped')
}

function toggleFlip(container) {
  isFlipped = !isFlipped
  const t = isFlipped ? 'scaleX(-1)' : ''
  videoEl.style.transform = t
  canvas.style.transform  = t
  container.querySelector('#fms-flip-btn').classList.toggle('active', isFlipped)
}

// ── Render loop ───────────────────────────────────────────────

function startLoop(container) {
  stopLoop()
  function loop(ts) {
    rafId = requestAnimationFrame(loop)
    const result = detectFrame(landmarker, 'pose', videoEl, ts)
    if (!result) return

    // Draw skeleton
    drawResults(ctx, result, 'pose', canvas.width, canvas.height)

    const wlm = result.worldLandmarks
    if (!wlm) return

    // Compute live score
    liveResult = selectedTest === 'deep-squat'
      ? scoreDeepSquat(wlm)
      : scoreHurdleStep(wlm, steppingLeg)

    // Phase detection
    const { phase } = phaseDetector.update(wlm, steppingLeg)

    // Auto-capture peak score at the key phase
    const isPeak = (selectedTest === 'deep-squat' && phase === 'bottom') ||
                   (selectedTest === 'hurdle-step' && phase === 'peak')

    if (isPeak && (!peakResult || liveResult.total >= peakResult.total)) {
      peakResult = { ...liveResult }
    }

    // Annotate canvas
    drawAnnotations(result.landmarks, wlm, liveResult, canvas.width, canvas.height)

    // Update score display
    renderScores(container, liveResult, peakResult)
    setPhase(container, phaseLabel(phase))
  }
  rafId = requestAnimationFrame(loop)
}

function stopLoop() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = null }
}

// ── Canvas annotations ────────────────────────────────────────
//
// Draws colored joint highlights and key angle labels on top of the skeleton.

const JOINT_PAIRS = {
  'deep-squat': [
    // [lm index, label suffix, related criterion index]
    [25, 'L knee', 2], [26, 'R knee', 2],
    [23, 'L hip',  0], [24, 'R hip',  0],
  ],
  'hurdle-step': [
    [25, 'L knee', 2], [26, 'R knee', 2],
    [23, 'L hip',  1], [24, 'R hip',  1],
  ],
}

function drawAnnotations(normLm, wlm, result, cw, ch) {
  if (!result) return
  const crit = result.criteria

  // Helper: convert normalized landmark to canvas px
  const px = i => ({ x: normLm[i].x * cw, y: normLm[i].y * ch })

  // Trunk-tibia angle label (deep squat) at mid-hip
  if (selectedTest === 'deep-squat') {
    const mhip = {
      x: (normLm[23].x + normLm[24].x) / 2 * cw,
      y: (normLm[23].y + normLm[24].y) / 2 * ch,
    }
    drawLabel(ctx, crit[1].detail, mhip.x + 12, mhip.y - 8, scoreColor(crit[1].score))
  }

  // Step height label (hurdle step) at stepping knee
  if (selectedTest === 'hurdle-step') {
    const kIdx = steppingLeg === 'left' ? 25 : 26
    const k = px(kIdx)
    drawLabel(ctx, crit[0].detail, k.x + 12, k.y - 8, scoreColor(crit[0].score))
  }

  // Knee alignment labels
  const kL = px(25), kR = px(26)
  drawLabel(ctx, `${crit[2].score}`, kL.x - 22, kL.y,  scoreColor(crit[2].score))
  drawLabel(ctx, `${crit[2].score}`, kR.x + 8,  kR.y,  scoreColor(crit[2].score))

  // Overall score badge — top-left corner
  const sc = result.total
  ctx.save()
  ctx.fillStyle = scoreColor(sc) + '22'
  roundRect(ctx, 10, 10, 80, 46, 8)
  ctx.fill()
  ctx.fillStyle = scoreColor(sc)
  ctx.font = 'bold 26px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText(sc, 50, 38)
  ctx.font = '10px system-ui, sans-serif'
  ctx.fillText(`FMS ${result.fmsEquiv}`, 50, 50)
  ctx.textAlign = 'left'
  ctx.restore()
}

function drawLabel(c, text, x, y, color) {
  c.save()
  c.font = 'bold 11px system-ui, sans-serif'
  c.fillStyle = color
  c.strokeStyle = '#00000099'
  c.lineWidth = 3
  c.strokeText(text, x, y)
  c.fillText(text, x, y)
  c.restore()
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath()
  c.moveTo(x + r, y)
  c.lineTo(x + w - r, y)
  c.quadraticCurveTo(x + w, y, x + w, y + r)
  c.lineTo(x + w, y + h - r)
  c.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  c.lineTo(x + r, y + h)
  c.quadraticCurveTo(x, y + h, x, y + h - r)
  c.lineTo(x, y + r)
  c.quadraticCurveTo(x, y, x + r, y)
  c.closePath()
}

// ── Score display ─────────────────────────────────────────────

function renderScores(container, live, peak) {
  const liveScoreEl = container.querySelector('#fms-live-score')
  const liveFmsEl   = container.querySelector('#fms-live-fms')
  const peakScoreEl = container.querySelector('#fms-peak-score')
  const peakFmsEl   = container.querySelector('#fms-peak-fms')
  const criteriaEl  = container.querySelector('#fms-criteria')

  if (live) {
    liveScoreEl.textContent = live.total
    liveScoreEl.style.color = scoreColor(live.total)
    liveFmsEl.textContent   = `FMS ${live.fmsEquiv}`
    liveFmsEl.style.color   = scoreColor(live.total)
  } else {
    liveScoreEl.textContent = '—'
    liveScoreEl.style.color = 'var(--text-muted)'
    liveFmsEl.textContent   = 'FMS —'
    liveFmsEl.style.color   = 'var(--text-muted)'
  }

  const displayResult = peak ?? live
  if (displayResult) {
    peakScoreEl.textContent = displayResult.total
    peakScoreEl.style.color = scoreColor(displayResult.total)
    peakFmsEl.textContent   = `FMS ${displayResult.fmsEquiv}`
    peakFmsEl.style.color   = scoreColor(displayResult.total)
    renderCriteria(criteriaEl, displayResult.criteria)
  } else {
    peakScoreEl.textContent = '—'
    peakScoreEl.style.color = 'var(--text-muted)'
    peakFmsEl.textContent   = 'FMS —'
    peakFmsEl.style.color   = 'var(--text-muted)'
    criteriaEl.innerHTML    = ''
  }
}

function renderCriteria(el, criteria) {
  el.innerHTML = criteria.map(c => {
    const color = scoreColor(c.score)
    const pct   = c.score
    return `
    <div style="margin-bottom:8px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:3px">
        <span style="font-size:12px;font-weight:600">${c.name}</span>
        <span style="font-size:12px;color:${color};font-weight:700">${c.score}
          <span style="font-size:10px;font-weight:400;color:var(--text-muted)">/ 100</span>
        </span>
      </div>
      <div style="height:6px;border-radius:3px;background:var(--border);overflow:hidden">
        <div style="height:100%;width:${pct}%;background:${color};border-radius:3px;transition:width .15s"></div>
      </div>
      <div style="font-size:10px;color:var(--text-muted);margin-top:2px">${c.detail} — ${c.description}</div>
    </div>`
  }).join('')
}

function setPhase(container, text) {
  const el = container.querySelector('#fms-phase')
  if (el) el.textContent = text
}

function phaseLabel(phase) {
  const labels = {
    waiting:   'Waiting for movement…',
    standing:  'Standing',
    descending:'Descending ↓',
    bottom:    '★ Bottom — peak captured',
    ascending: 'Ascending ↑',
    lifting:   'Lifting leg ↑',
    peak:      '★ Peak step — captured',
    returning: 'Returning ↓',
  }
  return labels[phase] ?? phase
}
