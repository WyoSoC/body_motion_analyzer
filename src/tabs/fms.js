import { getAllSessions, getTrialsBySession, getTrial } from '../db.js'
import {
  scoreDeepSquat, scoreHurdleStep,
  toFMS, scoreColor,
} from '../utils/fms_scoring.js'

// ── Module state ──────────────────────────────────────────────

let selectedTest = 'deep-squat'
let steppingLeg  = 'left'

// ── Entry point ───────────────────────────────────────────────

export async function initFMS(container) {
  container.innerHTML = buildUI()
  bindEvents(container)
  await loadSessions(container)
}

export function deactivateFMS() {}

// ── UI builder ────────────────────────────────────────────────

function buildUI() {
  return `
<div style="display:grid;grid-template-columns:1fr 2fr;gap:16px;align-items:start">

  <!-- Left panel: trial picker + controls -->
  <div>
    <div class="card">
      <div class="card-title">FMS Analysis</div>

      <div class="form-row">
        <label>Session</label>
        <select id="fms-session-sel"><option value="">— select session —</option></select>
      </div>

      <div class="form-row">
        <label>Trial</label>
        <select id="fms-trial-sel" disabled><option value="">— select trial —</option></select>
      </div>

      <div class="form-row">
        <label>Movement Test</label>
        <div class="toggle-group" id="fms-test-toggle">
          <button class="toggle-chip active" data-test="deep-squat">Deep Squat</button>
          <button class="toggle-chip"        data-test="hurdle-step">Hurdle Step</button>
        </div>
      </div>

      <div id="fms-leg-row" class="form-row hidden">
        <label>Stepping Leg</label>
        <div class="toggle-group" id="fms-leg-toggle">
          <button class="toggle-chip active" data-leg="left">Left</button>
          <button class="toggle-chip"        data-leg="right">Right</button>
        </div>
      </div>

      <div class="btn-group mt-8">
        <button class="btn btn-primary btn-sm" id="fms-analyze-btn" disabled>Analyze</button>
      </div>

      <div id="fms-status" style="margin-top:10px;font-size:12px;color:var(--text-muted)">
        Select a session and trial to begin.
      </div>
    </div>

    <!-- Instructions -->
    <div class="card">
      <div class="card-title">How it works</div>
      <p style="font-size:12.5px;color:var(--text-muted);line-height:1.7;margin:0">
        FMS scores are computed from the pose landmark data saved during
        Data Collection. Select a trial recorded with the Pose model,
        choose the movement test, then click <strong>Analyze</strong>.
        The peak score (best frame) and a score timeline will appear on the right.
      </p>
    </div>
  </div>

  <!-- Right panel: results -->
  <div id="fms-results" style="display:none">

    <!-- Peak score -->
    <div class="card" id="fms-score-card">
      <div class="card-title">Peak Score</div>

      <div style="display:flex;gap:20px;align-items:center;margin-bottom:14px">
        <div style="text-align:center">
          <div style="font-size:56px;font-weight:700;line-height:1" id="fms-peak-num" >—</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:2px" id="fms-peak-fms">FMS —</div>
        </div>
        <div style="flex:1">
          <div id="fms-criteria"></div>
        </div>
      </div>

      <div style="font-size:10.5px;color:var(--text-muted);line-height:1.5">
        Score is continuous 0–100 (finer than FMS 0–3).
        <strong>67+</strong> = FMS&nbsp;3 &nbsp;·&nbsp;
        <strong>34–66</strong> = FMS&nbsp;2 &nbsp;·&nbsp;
        <strong>1–33</strong> = FMS&nbsp;1
      </div>
    </div>

    <!-- Score over time -->
    <div class="card">
      <div class="card-title">Score Over Time</div>
      <svg id="fms-chart" width="100%" height="160"
        style="display:block;border-radius:6px;background:var(--surface2)">
      </svg>
      <div style="margin-top:6px;font-size:10.5px;color:var(--text-muted)">
        Each point = one recorded frame. Dashed lines: FMS 3 threshold (67) and FMS 2 threshold (34).
      </div>
    </div>

  </div>

  <!-- Placeholder when no results yet -->
  <div id="fms-empty" style="display:flex;align-items:center;justify-content:center;
    height:300px;color:var(--text-muted);font-size:13px;text-align:center">
    Select a trial and click Analyze to see results.
  </div>

</div>`
}

// ── Events ────────────────────────────────────────────────────

function bindEvents(container) {
  container.querySelector('#fms-session-sel').addEventListener('change', async e => {
    await loadTrials(container, Number(e.target.value))
  })

  container.querySelector('#fms-trial-sel').addEventListener('change', e => {
    const ok = !!e.target.value
    container.querySelector('#fms-analyze-btn').disabled = !ok
  })

  container.querySelector('#fms-analyze-btn').addEventListener('click', () => analyze(container))

  container.querySelectorAll('[data-test]').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedTest = btn.dataset.test
      container.querySelectorAll('[data-test]').forEach(b =>
        b.classList.toggle('active', b.dataset.test === selectedTest))
      container.querySelector('#fms-leg-row').classList.toggle('hidden', selectedTest !== 'hurdle-step')
    })
  })

  container.querySelectorAll('[data-leg]').forEach(btn => {
    btn.addEventListener('click', () => {
      steppingLeg = btn.dataset.leg
      container.querySelectorAll('[data-leg]').forEach(b =>
        b.classList.toggle('active', b.dataset.leg === steppingLeg))
    })
  })
}

// ── Data loading ──────────────────────────────────────────────

async function loadSessions(container) {
  const sessions = await getAllSessions()
  const sel = container.querySelector('#fms-session-sel')
  if (!sessions.length) {
    sel.innerHTML = '<option value="">No sessions found</option>'
    return
  }
  sel.innerHTML = '<option value="">— select session —</option>' +
    sessions.map(s =>
      `<option value="${s.id}">${s.name} (${new Date(s.date).toLocaleDateString()})</option>`
    ).join('')
}

async function loadTrials(container, sessionId) {
  const trialSel = container.querySelector('#fms-trial-sel')
  const analyzeBtn = container.querySelector('#fms-analyze-btn')

  if (!sessionId) {
    trialSel.innerHTML = '<option value="">— select trial —</option>'
    trialSel.disabled = true
    analyzeBtn.disabled = true
    return
  }

  const trials = await getTrialsBySession(sessionId)
  const poseTrials = trials.filter(t => t.model === 'pose' && t.landmarkData?.length)

  if (!poseTrials.length) {
    trialSel.innerHTML = '<option value="">No pose trials in this session</option>'
    trialSel.disabled = true
    analyzeBtn.disabled = true
    return
  }

  trialSel.innerHTML = '<option value="">— select trial —</option>' +
    poseTrials.map(t =>
      `<option value="${t.id}">${t.name} (${t.landmarkData.length} frames, ${t.duration?.toFixed(1) ?? '?'}s)</option>`
    ).join('')
  trialSel.disabled = false
  analyzeBtn.disabled = true
}

// ── Analysis ──────────────────────────────────────────────────

async function analyze(container) {
  const trialId = Number(container.querySelector('#fms-trial-sel').value)
  if (!trialId) return

  const statusEl = container.querySelector('#fms-status')
  statusEl.textContent = 'Analyzing…'

  const trial = await getTrial(trialId)
  const frames = trial.landmarkData.filter(f => f.worldLandmarks?.length === 33)

  if (!frames.length) {
    statusEl.textContent = 'No valid pose frames found in this trial.'
    return
  }

  const scores = frames.map(f => {
    const result = selectedTest === 'deep-squat'
      ? scoreDeepSquat(f.worldLandmarks)
      : scoreHurdleStep(f.worldLandmarks, steppingLeg)
    return { ts: f.timestamp, result }
  })

  const peakEntry = scores.reduce((best, s) =>
    s.result.total > best.result.total ? s : best
  )

  statusEl.textContent = `${frames.length} frames analyzed. Peak at ${(peakEntry.ts / 1000).toFixed(2)}s.`

  renderResults(container, scores, peakEntry.result)
}

// ── Rendering ──────────────────────────────────────────────────

function renderResults(container, scores, peak) {
  container.querySelector('#fms-results').style.display = ''
  container.querySelector('#fms-empty').style.display   = 'none'

  // Peak score
  const color = scoreColor(peak.total)
  const numEl = container.querySelector('#fms-peak-num')
  numEl.textContent  = peak.total
  numEl.style.color  = color
  const fmsEl = container.querySelector('#fms-peak-fms')
  fmsEl.textContent = `FMS ${peak.fmsEquiv}`
  fmsEl.style.color = color

  // Criteria breakdown
  const criteriaEl = container.querySelector('#fms-criteria')
  criteriaEl.innerHTML = peak.criteria.map(c => {
    const col = scoreColor(c.score)
    return `
    <div style="margin-bottom:8px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:3px">
        <span style="font-size:12px;font-weight:600">${c.name}</span>
        <span style="font-size:12px;color:${col};font-weight:700">${c.score}
          <span style="font-size:10px;font-weight:400;color:var(--text-muted)">/100</span>
        </span>
      </div>
      <div style="height:6px;border-radius:3px;background:var(--border);overflow:hidden">
        <div style="height:100%;width:${c.score}%;background:${col};border-radius:3px"></div>
      </div>
      <div style="font-size:10px;color:var(--text-muted);margin-top:2px">${c.detail} — ${c.description}</div>
    </div>`
  }).join('')

  // Score timeline chart
  drawChart(container.querySelector('#fms-chart'), scores)
}

function drawChart(svg, scores) {
  const W = svg.clientWidth || 600
  const H = 160
  const PAD = { top: 12, right: 12, bottom: 20, left: 36 }
  const cw = W - PAD.left - PAD.right
  const ch = H - PAD.top  - PAD.bottom

  const totals = scores.map(s => s.result.total)
  const maxTs  = scores[scores.length - 1]?.ts || 1

  const xScale = ts => PAD.left + (ts / maxTs) * cw
  const yScale = v  => PAD.top  + ch - (v / 100) * ch

  // Build polyline points
  const pts = scores.map(s => `${xScale(s.ts).toFixed(1)},${yScale(s.result.total).toFixed(1)}`).join(' ')

  // Color segments by score (simple approach: single colored line with inline style)
  // Use an area fill under the curve
  const areaStart = `${xScale(scores[0].ts).toFixed(1)},${yScale(0).toFixed(1)}`
  const areaEnd   = `${xScale(scores[scores.length-1].ts).toFixed(1)},${yScale(0).toFixed(1)}`
  const areaPath  = `M ${areaStart} L ${pts.replace(/^[^ ]+/, '')} L ${areaEnd} Z`

  const y67 = yScale(67).toFixed(1)
  const y34 = yScale(34).toFixed(1)
  const midScore = totals.reduce((a, b) => a + b, 0) / totals.length

  svg.innerHTML = `
    <defs>
      <linearGradient id="fms-grad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${scoreColor(midScore)}" stop-opacity="0.25"/>
        <stop offset="100%" stop-color="${scoreColor(midScore)}" stop-opacity="0.03"/>
      </linearGradient>
    </defs>

    <!-- Y-axis -->
    <line x1="${PAD.left}" y1="${PAD.top}" x2="${PAD.left}" y2="${PAD.top + ch}"
      stroke="var(--border)" stroke-width="1"/>

    <!-- Threshold lines -->
    <line x1="${PAD.left}" y1="${y67}" x2="${PAD.left + cw}" y2="${y67}"
      stroke="#3ecf70" stroke-width="1" stroke-dasharray="4 3" opacity="0.6"/>
    <text x="${PAD.left - 4}" y="${y67}" fill="#3ecf70" font-size="9" text-anchor="end"
      dominant-baseline="middle" opacity="0.8">67</text>

    <line x1="${PAD.left}" y1="${y34}" x2="${PAD.left + cw}" y2="${y34}"
      stroke="#f59e0b" stroke-width="1" stroke-dasharray="4 3" opacity="0.6"/>
    <text x="${PAD.left - 4}" y="${y34}" fill="#f59e0b" font-size="9" text-anchor="end"
      dominant-baseline="middle" opacity="0.8">34</text>

    <!-- X baseline -->
    <line x1="${PAD.left}" y1="${PAD.top + ch}" x2="${PAD.left + cw}" y2="${PAD.top + ch}"
      stroke="var(--border)" stroke-width="1"/>

    <!-- Area fill -->
    <path d="M ${pts.split(' ').map((p,i) => i===0 ? `${p}` : p).join(' L ')}
             L ${xScale(scores[scores.length-1].ts).toFixed(1)},${yScale(0).toFixed(1)}
             L ${xScale(scores[0].ts).toFixed(1)},${yScale(0).toFixed(1)} Z"
      fill="url(#fms-grad)"/>

    <!-- Score line -->
    <polyline points="${pts}"
      fill="none" stroke="${scoreColor(midScore)}" stroke-width="2"
      stroke-linejoin="round" stroke-linecap="round"/>

    <!-- X-axis labels -->
    <text x="${PAD.left}" y="${PAD.top + ch + 14}"
      fill="var(--text-muted)" font-size="9" text-anchor="middle">0s</text>
    <text x="${PAD.left + cw}" y="${PAD.top + ch + 14}"
      fill="var(--text-muted)" font-size="9" text-anchor="end">${(maxTs/1000).toFixed(1)}s</text>
  `
}
