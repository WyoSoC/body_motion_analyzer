import { getAllSessions, getTrialsBySession, getTrial } from '../db.js'
import {
  scoreDeepSquat, scoreHurdleStep,
  scoreColor,
} from '../utils/fms_scoring.js'

// ── Module state ──────────────────────────────────────────────

let selectedTest  = 'deep-squat'
let steppingLeg   = 'left'
let videoUrl      = null   // object URL — revoked on deactivate
let analyzeScores = []     // [{ts, result}] kept for timeupdate lookups
let analyzeMaxTs  = 1      // duration of last analyzed trial (ms)

// ── Entry point ───────────────────────────────────────────────

export async function initFMS(container) {
  container.innerHTML = buildUI()
  bindEvents(container)
  await loadSessions(container)
}

export function deactivateFMS() {
  if (videoUrl) { URL.revokeObjectURL(videoUrl); videoUrl = null }
}

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
        The peak score and score timeline will appear on the right.
        If the trial has a video recording, it will play back with a
        live score overlay synchronized to the chart.
      </p>
    </div>
  </div>

  <!-- Right panel: results -->
  <div id="fms-results" style="display:none">

    <!-- Video replay -->
    <div class="card" id="fms-video-card" style="display:none">
      <div class="card-title">Video Replay</div>
      <div class="camera-wrap" style="position:relative">
        <video id="fms-video" controls playsinline
          style="width:100%;border-radius:6px;display:block;background:#000"></video>
        <!-- Live score badge overlaid on video -->
        <div id="fms-live-badge" style="
          position:absolute;top:10px;left:10px;
          background:#00000088;border-radius:8px;padding:6px 12px;
          display:none;pointer-events:none">
          <div id="fms-live-num"
            style="font-size:28px;font-weight:700;line-height:1;color:#fff"></div>
          <div id="fms-live-fms"
            style="font-size:10px;color:#ffffffaa;margin-top:1px"></div>
        </div>
      </div>
      <div style="margin-top:6px;font-size:11px;color:var(--text-muted)">
        Click on the score chart below to seek to any point in the trial.
      </div>
    </div>

    <!-- Peak score -->
    <div class="card">
      <div class="card-title">Peak Score</div>
      <div style="display:flex;gap:20px;align-items:center;margin-bottom:14px">
        <div style="text-align:center">
          <div style="font-size:56px;font-weight:700;line-height:1" id="fms-peak-num">—</div>
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
        style="display:block;border-radius:6px;background:var(--surface2);cursor:pointer">
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
    container.querySelector('#fms-analyze-btn').disabled = !e.target.value
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
  const trialSel   = container.querySelector('#fms-trial-sel')
  const analyzeBtn = container.querySelector('#fms-analyze-btn')

  if (!sessionId) {
    trialSel.innerHTML = '<option value="">— select trial —</option>'
    trialSel.disabled  = true
    analyzeBtn.disabled = true
    return
  }

  const trials     = await getTrialsBySession(sessionId)
  const poseTrials = trials.filter(t => t.model === 'pose' && t.landmarkData?.length)

  if (!poseTrials.length) {
    trialSel.innerHTML = '<option value="">No pose trials in this session</option>'
    trialSel.disabled  = true
    analyzeBtn.disabled = true
    return
  }

  trialSel.innerHTML = '<option value="">— select trial —</option>' +
    poseTrials.map(t => {
      const hasVideo = t.videoBlob ? ' 🎬' : ''
      return `<option value="${t.id}">${t.name}${hasVideo} (${t.landmarkData.length} frames, ${t.duration?.toFixed(1) ?? '?'}s)</option>`
    }).join('')
  trialSel.disabled   = false
  analyzeBtn.disabled = true
}

// ── Analysis ──────────────────────────────────────────────────

async function analyze(container) {
  const trialId = Number(container.querySelector('#fms-trial-sel').value)
  if (!trialId) return

  const statusEl = container.querySelector('#fms-status')
  statusEl.textContent = 'Analyzing…'

  const trial  = await getTrial(trialId)
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

  analyzeScores = scores
  analyzeMaxTs  = scores[scores.length - 1].ts

  statusEl.textContent =
    `${frames.length} frames analyzed. Peak at ${(peakEntry.ts / 1000).toFixed(2)}s.`

  renderResults(container, scores, peakEntry.result, trial)
}

// ── Rendering ────────────────────────────────────────────────

function renderResults(container, scores, peak, trial) {
  container.querySelector('#fms-results').style.display = ''
  container.querySelector('#fms-empty').style.display   = 'none'

  // Video replay
  setupVideo(container, trial)

  // Peak score
  const color = scoreColor(peak.total)
  const numEl = container.querySelector('#fms-peak-num')
  numEl.textContent = peak.total
  numEl.style.color = color
  const fmsEl = container.querySelector('#fms-peak-fms')
  fmsEl.textContent = `FMS ${peak.fmsEquiv}`
  fmsEl.style.color = color

  // Criteria breakdown
  container.querySelector('#fms-criteria').innerHTML = peak.criteria.map(c => {
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

  // Chart
  drawChart(container, scores)
}

// ── Video setup ───────────────────────────────────────────────

function setupVideo(container, trial) {
  const videoCard = container.querySelector('#fms-video-card')
  const videoEl   = container.querySelector('#fms-video')

  if (!trial.videoBlob) {
    videoCard.style.display = 'none'
    return
  }

  videoCard.style.display = ''

  // Revoke any previous object URL before creating a new one
  if (videoUrl) URL.revokeObjectURL(videoUrl)
  videoUrl = URL.createObjectURL(trial.videoBlob)
  videoEl.src = videoUrl

  // Remove any previous listener by cloning
  const fresh = videoEl.cloneNode(true)
  fresh.src = videoUrl
  videoEl.replaceWith(fresh)

  fresh.addEventListener('timeupdate', () => onTimeUpdate(container, fresh))
  fresh.addEventListener('play',  () => container.querySelector('#fms-live-badge').style.display = '')
  fresh.addEventListener('pause', () => container.querySelector('#fms-live-badge').style.display = 'none')
  fresh.addEventListener('ended', () => container.querySelector('#fms-live-badge').style.display = 'none')
}

function onTimeUpdate(container, videoEl) {
  const currentMs = videoEl.currentTime * 1000

  // Find nearest scored frame (binary search)
  const entry = nearestScore(analyzeScores, currentMs)
  if (!entry) return

  // Update live badge
  const color = scoreColor(entry.result.total)
  const numEl = container.querySelector('#fms-live-num')
  const fmsEl = container.querySelector('#fms-live-fms')
  if (numEl) { numEl.textContent = entry.result.total; numEl.style.color = color }
  if (fmsEl) { fmsEl.textContent = `FMS ${entry.result.fmsEquiv}` }

  // Update chart cursor
  updateCursor(container.querySelector('#fms-chart'), currentMs)
}

function nearestScore(scores, targetMs) {
  if (!scores.length) return null
  let lo = 0, hi = scores.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (scores[mid].ts < targetMs) lo = mid + 1
    else hi = mid
  }
  if (lo > 0 && Math.abs(scores[lo - 1].ts - targetMs) < Math.abs(scores[lo].ts - targetMs))
    lo--
  return scores[lo]
}

// ── Chart ─────────────────────────────────────────────────────

const CHART_PAD = { top: 12, right: 12, bottom: 20, left: 36 }

function drawChart(container, scores) {
  const svg  = container.querySelector('#fms-chart')
  const W    = svg.clientWidth || 600
  const H    = 160
  const { top, right, bottom, left } = CHART_PAD
  const cw   = W - left - right
  const ch   = H - top  - bottom
  const maxTs = scores[scores.length - 1]?.ts || 1

  const xScale = ts => left + (ts / maxTs) * cw
  const yScale = v  => top  + ch - (v / 100) * ch

  const pts = scores
    .map(s => `${xScale(s.ts).toFixed(1)},${yScale(s.result.total).toFixed(1)}`)
    .join(' ')

  const totals   = scores.map(s => s.result.total)
  const midScore = totals.reduce((a, b) => a + b, 0) / totals.length
  const lineColor = scoreColor(midScore)
  const y67 = yScale(67).toFixed(1)
  const y34 = yScale(34).toFixed(1)

  svg.innerHTML = `
    <defs>
      <linearGradient id="fms-grad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%"   stop-color="${lineColor}" stop-opacity="0.25"/>
        <stop offset="100%" stop-color="${lineColor}" stop-opacity="0.03"/>
      </linearGradient>
    </defs>

    <line x1="${left}" y1="${top}" x2="${left}" y2="${top+ch}"
      stroke="var(--border)" stroke-width="1"/>

    <line x1="${left}" y1="${y67}" x2="${left+cw}" y2="${y67}"
      stroke="#3ecf70" stroke-width="1" stroke-dasharray="4 3" opacity="0.6"/>
    <text x="${left-4}" y="${y67}" fill="#3ecf70" font-size="9" text-anchor="end"
      dominant-baseline="middle" opacity="0.8">67</text>

    <line x1="${left}" y1="${y34}" x2="${left+cw}" y2="${y34}"
      stroke="#f59e0b" stroke-width="1" stroke-dasharray="4 3" opacity="0.6"/>
    <text x="${left-4}" y="${y34}" fill="#f59e0b" font-size="9" text-anchor="end"
      dominant-baseline="middle" opacity="0.8">34</text>

    <line x1="${left}" y1="${top+ch}" x2="${left+cw}" y2="${top+ch}"
      stroke="var(--border)" stroke-width="1"/>

    <path d="M ${pts.split(' ').join(' L ')}
             L ${xScale(scores[scores.length-1].ts).toFixed(1)},${yScale(0).toFixed(1)}
             L ${xScale(scores[0].ts).toFixed(1)},${yScale(0).toFixed(1)} Z"
      fill="url(#fms-grad)"/>

    <polyline points="${pts}" fill="none" stroke="${lineColor}" stroke-width="2"
      stroke-linejoin="round" stroke-linecap="round"/>

    <text x="${left}" y="${top+ch+14}"
      fill="var(--text-muted)" font-size="9" text-anchor="middle">0s</text>
    <text x="${left+cw}" y="${top+ch+14}"
      fill="var(--text-muted)" font-size="9" text-anchor="end">${(maxTs/1000).toFixed(1)}s</text>

    <!-- Playhead cursor (hidden until video plays) -->
    <line id="fms-cursor" x1="${left}" y1="${top}" x2="${left}" y2="${top+ch}"
      stroke="white" stroke-width="1.5" opacity="0.85" display="none"/>

    <!-- Transparent hit area for seek clicks -->
    <rect id="fms-chart-hit" x="${left}" y="${top}" width="${cw}" height="${ch}"
      fill="transparent"/>
  `

  // Seek on chart click
  svg.querySelector('#fms-chart-hit').addEventListener('click', e => {
    const rect = svg.getBoundingClientRect()
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left - left) / cw))
    const video = container.querySelector('#fms-video')
    if (video?.src) video.currentTime = frac * maxTs / 1000
  })
}

function updateCursor(svg, currentMs) {
  const cursor = svg?.querySelector('#fms-cursor')
  if (!cursor) return
  const W  = svg.clientWidth || 600
  const { left, right } = CHART_PAD
  const cw = W - left - right
  const x  = (left + (currentMs / analyzeMaxTs) * cw).toFixed(1)
  cursor.setAttribute('x1', x)
  cursor.setAttribute('x2', x)
  cursor.removeAttribute('display')
}
