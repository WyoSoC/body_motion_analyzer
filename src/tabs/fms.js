import { getAllSessions, getTrialsBySession, getTrial } from '../db.js'
import { loadReferenceManifest, segmentUrl, findSegment, loadReferenceLandmarks } from '../utils/reference.js'
import { scoreAgainstReference, scoreColor } from '../utils/fms_dtw.js'

// All 7 FMS movement tests. Ids match the reference manifest segment ids.
const TESTS = [
  { id: 'deep-squat',                label: 'Deep Squat' },
  { id: 'hurdle-step',               label: 'Hurdle Step' },
  { id: 'inline-lunge',              label: 'In-Line Lunge' },
  { id: 'shoulder-mobility',         label: 'Shoulder Mobility' },
  { id: 'active-straight-leg-raise', label: 'Leg Raise (ASLR)' },
  { id: 'trunk-stability-pushup',    label: 'Push-Up' },
  { id: 'rotary-stability',          label: 'Rotary Stability' },
]

// ── Pose skeleton connections (MediaPipe Pose 33-landmark model) ──
const POSE_CONN = [
  [0,1],[1,2],[2,3],[3,7],[0,4],[4,5],[5,6],[6,8],
  [9,10],[11,12],
  [11,13],[13,15],[15,17],[15,19],[17,19],[15,21],
  [12,14],[14,16],[16,18],[16,20],[18,20],[16,22],
  [11,23],[12,24],[23,24],
  [23,25],[25,27],[27,29],[27,31],[29,31],
  [24,26],[26,28],[28,30],[28,32],[30,32],
]

// ── Module state ──────────────────────────────────────────────

let selectedTest  = 'deep-squat'
let videoUrl      = null   // object URL — revoked on deactivate
let analyzeScores = []     // [{ts, result}] for timeupdate score lookup
let analyzeFrames = []     // [{ts, landmarks}] for skeleton drawing
let analyzeMaxTs  = 1      // duration in ms of last analyzed trial
let refManifest   = null   // FMS reference video manifest (null if unavailable)

// ── Entry point ───────────────────────────────────────────────

export async function initFMS(container) {
  container.innerHTML = buildUI()
  bindEvents(container)
  await loadSessions(container)
  refManifest = await loadReferenceManifest()
  updateReferenceVideo(container)
}

export function deactivateFMS() {
  if (videoUrl) { URL.revokeObjectURL(videoUrl); videoUrl = null }
  document.querySelector('#fms-ref-video')?.pause()
}

// ── UI builder ────────────────────────────────────────────────

function buildUI() {
  return `
<div style="display:grid;grid-template-columns:1fr 2fr;gap:16px;align-items:start">

  <!-- Left panel: controls + video replay -->
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
        <div class="toggle-group" id="fms-test-toggle" style="flex-wrap:wrap">
          ${TESTS.map((t, i) => `
          <button class="toggle-chip ${i === 0 ? 'active' : ''}" data-test="${t.id}">${t.label}</button>`
          ).join('')}
        </div>
      </div>

      <div class="btn-group mt-8">
        <button class="btn btn-primary btn-sm" id="fms-analyze-btn" disabled>Analyze</button>
      </div>

      <div id="fms-status" style="margin-top:10px;font-size:12px;color:var(--text-muted)">
        Select a session and trial to begin.
      </div>
    </div>

    <!-- Reference video for the selected movement test -->
    <div class="card" id="fms-ref-card" style="display:none">
      <div class="card-title">Reference — <span id="fms-ref-name"></span></div>
      <video id="fms-ref-video" controls loop muted playsinline preload="metadata"
        style="width:100%;display:block;border-radius:6px;background:#000"></video>
      <div style="margin-top:6px;font-size:11px;color:var(--text-muted)">
        Gold-standard demonstration of this movement (scores as 100).
      </div>
    </div>

    <!-- Video replay (shown after analyze when trial has video) -->
    <div class="card" id="fms-video-card" style="display:none">
      <div class="card-title">Video Replay</div>

      <!-- Wrapper sizes to the video's natural aspect ratio -->
      <div id="fms-video-wrap" style="
        position:relative;background:#000;
        border-radius:6px;overflow:hidden;line-height:0">
        <video id="fms-video" controls playsinline
          style="width:100%;display:block"></video>
        <canvas id="fms-overlay"
          style="position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none">
        </canvas>
        <!-- Live score badge -->
        <div id="fms-live-badge" style="
          position:absolute;top:8px;left:8px;
          background:#00000099;border-radius:8px;padding:5px 10px;
          display:none;pointer-events:none;backdrop-filter:blur(4px)">
          <div id="fms-live-num"
            style="font-size:26px;font-weight:700;line-height:1;color:#fff"></div>
          <div id="fms-live-label"
            style="font-size:10px;color:#ffffffaa;margin-top:1px"></div>
        </div>
      </div>

      <div style="margin-top:6px;font-size:11px;color:var(--text-muted)">
        Pose markers shown. Click the score chart to seek.
      </div>
    </div>
  </div>

  <!-- Right panel: results -->
  <div id="fms-results" style="display:none">

    <!-- Reference similarity (DTW) — all tests -->
    <div class="card" id="fms-dtw-card" style="display:none">
      <div class="card-title">Reference Similarity (DTW)</div>

      <div style="display:flex;gap:20px;align-items:center;margin-bottom:18px">
        <div style="text-align:center;min-width:72px">
          <div style="font-size:56px;font-weight:700;line-height:1" id="fms-dtw-num">—</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:2px" id="fms-dtw-fms">FMS —</div>
          <div style="font-size:10px;color:var(--text-muted);margin-top:4px">out of 100</div>
        </div>
        <div style="width:1px;background:var(--border);align-self:stretch"></div>
        <div style="flex:1;font-size:11px;color:var(--text-muted);line-height:1.6">
          Joint-angle trajectories aligned to the gold-standard reference with
          Dynamic Time Warping — tempo differences don't cost points, deviations
          from the reference movement pattern do.
          <span id="fms-dtw-meta" style="display:block;margin-top:4px"></span>
        </div>
      </div>

      <div id="fms-dtw-groups"></div>
    </div>

    <!-- Score over time -->
    <div class="card">
      <div class="card-title">Score Over Time</div>
      <svg id="fms-chart" width="100%" height="160"
        style="display:block;border-radius:6px;background:var(--surface2);cursor:pointer">
      </svg>
      <div id="fms-chart-note" style="margin-top:6px;font-size:10.5px;color:var(--text-muted)">
        Each point = one recorded frame.
        Dashed lines mark FMS 3 (67) and FMS 2 (34) thresholds.
        Click to seek the video.
      </div>
    </div>

  </div>

  <!-- Placeholder when no results yet -->
  <div id="fms-empty" style="
    display:flex;align-items:center;justify-content:center;
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
      updateReferenceVideo(container)
    })
  })
}

// ── Reference video ───────────────────────────────────────────

function updateReferenceVideo(container) {
  const card = container.querySelector('#fms-ref-card')
  if (!card) return

  const seg = findSegment(refManifest, selectedTest)
  if (!seg) { card.style.display = 'none'; return }

  const video = container.querySelector('#fms-ref-video')
  const url   = segmentUrl(seg)
  if (!video.src.endsWith(url)) video.src = url
  container.querySelector('#fms-ref-name').textContent = seg.name
  card.style.display = ''
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
    trialSel.innerHTML  = '<option value="">— select trial —</option>'
    trialSel.disabled   = true
    analyzeBtn.disabled = true
    return
  }

  const trials     = await getTrialsBySession(sessionId)
  const poseTrials = trials.filter(t => t.model === 'pose' && t.landmarkData?.length)

  if (!poseTrials.length) {
    trialSel.innerHTML  = '<option value="">No pose trials in this session</option>'
    trialSel.disabled   = true
    analyzeBtn.disabled = true
    return
  }

  trialSel.innerHTML = '<option value="">— select trial —</option>' +
    poseTrials.map(t => {
      const tag = t.videoBlob ? ' 🎬' : ''
      return `<option value="${t.id}">${t.name}${tag} · ${t.landmarkData.length} frames · ${t.duration?.toFixed(1) ?? '?'}s</option>`
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

  // DTW similarity against the gold-standard reference — all tests
  const refData = await loadReferenceLandmarks(refManifest, selectedTest)
  const dtwResult = refData ? scoreAgainstReference(frames, refData, selectedTest) : null

  if (!dtwResult) {
    statusEl.textContent =
      'No reference landmarks available for this test — run scripts/extract_reference_landmarks.py first.'
    return
  }

  // Per-frame DTW similarity series — drives the chart, video badge, and seek cursor.
  const scores = dtwResult.perFrame.map(p => ({
    ts: p.ts,
    result: { total: p.score, fmsEquiv: p.score >= 67 ? 3 : p.score >= 34 ? 2 : p.score >= 1 ? 1 : 0 },
  }))

  analyzeScores = scores
  analyzeFrames = frames.map(f => ({ ts: f.timestamp, landmarks: f.landmarks }))
  analyzeMaxTs  = scores[scores.length - 1].ts

  statusEl.textContent = `${frames.length} frames analyzed · DTW similarity ${dtwResult.total}`

  renderResults(container, { scores, dtwResult, trial })
}

// ── Rendering ────────────────────────────────────────────────

function renderResults(container, { scores, dtwResult, trial }) {
  container.querySelector('#fms-results').style.display = ''
  container.querySelector('#fms-empty').style.display   = 'none'

  setupVideo(container, trial)
  renderDTW(container, dtwResult)

  drawChart(container, scores)

  const chartNote = container.querySelector('#fms-chart-note')
  if (chartNote) {
    chartNote.textContent =
      'Each point = one recorded frame (DTW similarity to the aligned reference frame). Dashed lines mark FMS 3 (67) and FMS 2 (34) thresholds. Click to seek the video.'
  }
}

function renderDTW(container, dtw) {
  const card = container.querySelector('#fms-dtw-card')
  if (!dtw) { card.style.display = 'none'; return }
  card.style.display = ''

  const color = scoreColor(dtw.total)
  const numEl = container.querySelector('#fms-dtw-num')
  numEl.textContent = dtw.total
  numEl.style.color = color

  const fmsEl = container.querySelector('#fms-dtw-fms')
  fmsEl.textContent = `FMS ${dtw.fmsEquiv}`
  fmsEl.style.color = color

  container.querySelector('#fms-dtw-meta').textContent =
    `Avg deviation ${dtw.avgDev.toFixed(1)}° per joint` +
    (dtw.mirrored ? ' · scored mirrored (opposite lead side)' : '')

  container.querySelector('#fms-dtw-groups').innerHTML = dtw.groups.map(g => {
    const col = scoreColor(g.score)
    return `
    <div style="margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">
        <span style="font-size:13px;font-weight:600">${g.name}</span>
        <span style="display:flex;align-items:baseline;gap:6px">
          <span style="font-size:11px;color:var(--text-muted)">${Math.round(g.weight * 100)} %</span>
          <span style="font-size:14px;color:${col};font-weight:700">${g.score}
            <span style="font-size:10px;font-weight:400;color:var(--text-muted)">/100</span>
          </span>
        </span>
      </div>
      <div style="height:7px;border-radius:4px;background:var(--border);overflow:hidden;margin-bottom:4px">
        <div style="height:100%;width:${g.score}%;background:${col};border-radius:4px;transition:width .2s"></div>
      </div>
      <div style="font-size:11px;color:var(--text-muted)">
        Avg deviation from reference: ${g.dev.toFixed(1)}°
      </div>
    </div>`
  }).join('')
}

// ── Video setup ───────────────────────────────────────────────

function setupVideo(container, trial) {
  const videoCard = container.querySelector('#fms-video-card')

  if (!trial.videoBlob) {
    videoCard.style.display = 'none'
    return
  }

  videoCard.style.display = ''

  if (videoUrl) URL.revokeObjectURL(videoUrl)
  videoUrl = URL.createObjectURL(trial.videoBlob)

  // Replace video element to clear any previous listeners
  const oldVideo = container.querySelector('#fms-video')
  const newVideo = oldVideo.cloneNode(false)
  newVideo.src = videoUrl
  oldVideo.replaceWith(newVideo)

  const canvas = container.querySelector('#fms-overlay')

  newVideo.addEventListener('loadedmetadata', () => {
    canvas.width  = newVideo.videoWidth
    canvas.height = newVideo.videoHeight
  })

  newVideo.addEventListener('timeupdate', () => onTimeUpdate(container, newVideo, canvas))

  const badge = container.querySelector('#fms-live-badge')
  newVideo.addEventListener('play',  () => { badge.style.display = '' })
  newVideo.addEventListener('pause', () => {
    // Keep badge visible on pause so user can read the score at that frame
  })
  newVideo.addEventListener('ended', () => { badge.style.display = 'none' })
}

function onTimeUpdate(container, video, canvas) {
  const currentMs = video.currentTime * 1000

  // Draw skeleton on nearest frame
  const frame = nearestByTs(analyzeFrames, currentMs)
  if (frame?.landmarks) {
    drawSkeleton(canvas.getContext('2d'), frame.landmarks, canvas.width, canvas.height)
  }

  // Update live score badge
  const scoreEntry = nearestByTs(analyzeScores, currentMs)
  if (scoreEntry) {
    const col = scoreColor(scoreEntry.result.total)
    const numEl   = container.querySelector('#fms-live-num')
    const labelEl = container.querySelector('#fms-live-label')
    if (numEl)   { numEl.textContent = scoreEntry.result.total; numEl.style.color = col }
    if (labelEl) { labelEl.textContent = `FMS ${scoreEntry.result.fmsEquiv}` }
    container.querySelector('#fms-live-badge').style.display = ''
  }

  // Update chart cursor
  updateCursor(container.querySelector('#fms-chart'), currentMs)
}

// Binary search for the entry with ts nearest to targetMs
function nearestByTs(arr, targetMs) {
  if (!arr.length) return null
  let lo = 0, hi = arr.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid].ts < targetMs) lo = mid + 1
    else hi = mid
  }
  if (lo > 0 && Math.abs(arr[lo-1].ts - targetMs) < Math.abs(arr[lo].ts - targetMs)) lo--
  return arr[lo]
}

// ── Skeleton drawing ──────────────────────────────────────────

function drawSkeleton(ctx, landmarks, w, h) {
  if (!landmarks?.length || !w || !h) return
  ctx.clearRect(0, 0, w, h)

  // Connections
  ctx.lineWidth = 2
  for (const [a, b] of POSE_CONN) {
    const lA = landmarks[a], lB = landmarks[b]
    if (!lA || !lB) continue
    const vis = Math.min(lA.visibility ?? 1, lB.visibility ?? 1)
    if (vis < 0.3) continue
    ctx.globalAlpha = Math.max(0.4, vis)
    ctx.strokeStyle = '#38bdf8'
    ctx.beginPath()
    ctx.moveTo(lA.x * w, lA.y * h)
    ctx.lineTo(lB.x * w, lB.y * h)
    ctx.stroke()
  }

  // Landmark dots
  ctx.globalAlpha = 1
  for (const lm of landmarks) {
    if ((lm.visibility ?? 1) < 0.3) continue
    ctx.beginPath()
    ctx.arc(lm.x * w, lm.y * h, 3, 0, Math.PI * 2)
    ctx.fillStyle = '#ffffff'
    ctx.fill()
    ctx.strokeStyle = '#38bdf8'
    ctx.lineWidth = 1.5
    ctx.stroke()
  }
}

// ── Chart ─────────────────────────────────────────────────────

const PAD = { top: 12, right: 12, bottom: 20, left: 36 }

function drawChart(container, scores) {
  const svg = container.querySelector('#fms-chart')
  const W   = svg.clientWidth || 600
  const H   = 160
  const cw  = W - PAD.left - PAD.right
  const ch  = H - PAD.top  - PAD.bottom
  const maxTs = scores[scores.length - 1]?.ts || 1

  const xScale = ts => PAD.left + (ts / maxTs) * cw
  const yScale = v  => PAD.top  + ch - (v / 100) * ch

  const pts = scores
    .map(s => `${xScale(s.ts).toFixed(1)},${yScale(s.result.total).toFixed(1)}`)
    .join(' ')

  const totals    = scores.map(s => s.result.total)
  const midScore  = totals.reduce((a, b) => a + b, 0) / totals.length
  const lineColor = scoreColor(midScore)

  const y67 = yScale(67).toFixed(1)
  const y34 = yScale(34).toFixed(1)
  const x0  = xScale(scores[0].ts).toFixed(1)
  const x1  = xScale(scores[scores.length-1].ts).toFixed(1)

  svg.innerHTML = `
    <defs>
      <linearGradient id="fms-grad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%"   stop-color="${lineColor}" stop-opacity="0.25"/>
        <stop offset="100%" stop-color="${lineColor}" stop-opacity="0.03"/>
      </linearGradient>
    </defs>

    <line x1="${PAD.left}" y1="${PAD.top}" x2="${PAD.left}" y2="${PAD.top+ch}"
      stroke="var(--border)" stroke-width="1"/>
    <line x1="${PAD.left}" y1="${PAD.top+ch}" x2="${PAD.left+cw}" y2="${PAD.top+ch}"
      stroke="var(--border)" stroke-width="1"/>

    <line x1="${PAD.left}" y1="${y67}" x2="${PAD.left+cw}" y2="${y67}"
      stroke="#3ecf70" stroke-width="1" stroke-dasharray="4 3" opacity="0.6"/>
    <text x="${PAD.left-4}" y="${y67}" fill="#3ecf70" font-size="9" text-anchor="end"
      dominant-baseline="middle" opacity="0.8">67</text>

    <line x1="${PAD.left}" y1="${y34}" x2="${PAD.left+cw}" y2="${y34}"
      stroke="#f59e0b" stroke-width="1" stroke-dasharray="4 3" opacity="0.6"/>
    <text x="${PAD.left-4}" y="${y34}" fill="#f59e0b" font-size="9" text-anchor="end"
      dominant-baseline="middle" opacity="0.8">34</text>

    <path d="M ${pts.split(' ').join(' L ')} L ${x1},${yScale(0).toFixed(1)} L ${x0},${yScale(0).toFixed(1)} Z"
      fill="url(#fms-grad)"/>

    <polyline points="${pts}" fill="none" stroke="${lineColor}" stroke-width="2"
      stroke-linejoin="round" stroke-linecap="round"/>

    <text x="${PAD.left}" y="${PAD.top+ch+14}"
      fill="var(--text-muted)" font-size="9" text-anchor="middle">0s</text>
    <text x="${PAD.left+cw}" y="${PAD.top+ch+14}"
      fill="var(--text-muted)" font-size="9" text-anchor="end">${(maxTs/1000).toFixed(1)}s</text>

    <line id="fms-cursor"
      x1="${PAD.left}" y1="${PAD.top}" x2="${PAD.left}" y2="${PAD.top+ch}"
      stroke="white" stroke-width="1.5" opacity="0.85" display="none"/>

    <rect id="fms-chart-hit"
      x="${PAD.left}" y="${PAD.top}" width="${cw}" height="${ch}"
      fill="transparent"/>
  `

  svg.querySelector('#fms-chart-hit').addEventListener('click', e => {
    const rect = svg.getBoundingClientRect()
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left - PAD.left) / cw))
    const video = container.querySelector('#fms-video')
    if (video?.src) video.currentTime = frac * maxTs / 1000
  })
}

function updateCursor(svg, currentMs) {
  const cursor = svg?.querySelector('#fms-cursor')
  if (!cursor) return
  const cw = (svg.clientWidth || 600) - PAD.left - PAD.right
  const x  = (PAD.left + (currentMs / analyzeMaxTs) * cw).toFixed(1)
  cursor.setAttribute('x1', x)
  cursor.setAttribute('x2', x)
  cursor.removeAttribute('display')
}
