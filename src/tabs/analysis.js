import Chart from 'chart.js/auto'
import { getAllSessions, getTrialsBySession, getTrial, getCalibration, downloadBlob, exportTrialCSV } from '../db.js'
import { getGroups, getLandmarkNames } from '../utils/landmarks.js'
import {
  extractLandmarkTimeSeries,
  computeSpeed, computeAcceleration, computeJerk,
  computeNormalizedJerk, computeSampleEntropy, computeROM,
  summarize, METRIC_DEFS
} from '../utils/metrics.js'
import { drawStoredFrame } from '../utils/mediapipe.js'

let allSessions = []
let currentTrial = null
let currentCalibration = null

let activeMetrics = new Set(['speed'])
let activeGroup   = null          // name of highlighted group chip, or null
let customIndices = new Set()     // always the source of truth for which landmarks to plot

let charts = {}
let playbackRAF = null

// 33-color palette (golden-angle HSL beyond the list)
const COLOR_PALETTE = [
  '#5b7fff','#3ecf70','#f59e0b','#ef4444','#8b5cf6','#06b6d4',
  '#f43f5e','#10b981','#fbbf24','#a78bfa','#34d399','#60a5fa',
  '#fb923c','#e879f9','#4ade80','#38bdf8','#facc15','#c084fc',
  '#94a3b8','#84cc16','#0ea5e9','#d946ef','#22d3ee','#f97316',
  '#a3e635','#e11d48','#2dd4bf','#7c3aed','#ca8a04','#15803d',
  '#1d4ed8','#9f1239','#065f46',
]
function getColor(i) {
  return i < COLOR_PALETTE.length
    ? COLOR_PALETTE[i]
    : `hsl(${(i * 137.5) % 360},75%,60%)`
}

export async function initAnalysis(container) {
  container.innerHTML = buildUI()
  await loadSessions(container)
  bindEvents(container)
}

// ── UI ────────────────────────────────────────────────────────

function buildUI() {
  return `
<div class="two-col" style="align-items:start">

  <!-- Left: trial browser + video playback -->
  <div>
    <div class="card">
      <div class="card-title">Select Trial</div>
      <div class="form-row">
        <label>Session</label>
        <select id="an-session-sel">
          <option value="">— Select session —</option>
        </select>
      </div>
      <div class="form-row">
        <label>Trial</label>
        <select id="an-trial-sel">
          <option value="">— Select trial —</option>
        </select>
      </div>
      <button class="btn btn-primary btn-sm" id="an-load-btn" disabled>Load Trial</button>
    </div>

    <!-- Video playback -->
    <div class="card" id="an-video-card" style="display:none">
      <div class="card-title">Video Playback</div>
      <div class="camera-wrap" id="an-video-wrap">
        <video id="an-video" controls></video>
        <canvas id="an-video-overlay"></canvas>
      </div>
      <div class="btn-group mt-8">
        <button class="btn btn-ghost btn-sm" id="an-export-csv">⬇ Export CSV</button>
        <button class="btn btn-ghost btn-sm" id="an-export-video">⬇ Export Video</button>
      </div>
    </div>

    <!-- Group analysis -->
    <div class="card">
      <div class="card-title">Group Analysis</div>
      <div id="an-group-select-area">
        <div class="form-row">
          <label>Select multiple trials</label>
          <select id="an-multi-trial-sel" multiple style="height:100px"></select>
        </div>
        <button class="btn btn-primary btn-sm" id="an-group-analyze">Compare Trials</button>
      </div>
      <div id="an-group-chart-area"></div>
    </div>
  </div>

  <!-- Right: analysis controls + charts -->
  <div>
    <!-- Metric toggles -->
    <div class="card">
      <div class="card-title">Metrics</div>
      <div class="toggle-group" id="an-metric-toggles">
        ${METRIC_DEFS.map(m => `
          <button class="toggle-chip ${m.key === 'speed' ? 'active' : ''}" data-metric="${m.key}">
            ${m.label}
          </button>`).join('')}
      </div>
    </div>

    <!-- Landmark group / custom selector -->
    <div class="card">
      <div class="card-title">Landmark Groups</div>
      <div class="toggle-group" id="an-group-toggles"></div>
      <hr/>
      <div class="card-title" style="margin-top:8px">Custom Landmarks</div>
      <div id="an-landmark-checkboxes" style="
        display:flex;flex-wrap:wrap;gap:6px;max-height:160px;overflow-y:auto;font-size:11px
      "></div>
      <div class="btn-group mt-8">
        <button class="btn btn-ghost btn-sm" id="an-use-custom">Use Custom Selection</button>
        <button class="btn btn-ghost btn-sm" id="an-clear-custom">Clear Custom</button>
      </div>
    </div>

    <!-- Summary stats -->
    <div class="card" id="an-stats-card" style="display:none">
      <div class="card-title">Summary Statistics</div>
      <div id="an-stats-content"></div>
    </div>

    <!-- Charts -->
    <div id="an-charts-area"></div>
  </div>
</div>
`
}

// ── Data loading ──────────────────────────────────────────────

async function loadSessions(container) {
  allSessions = await getAllSessions()
  const sel = container.querySelector('#an-session-sel')
  sel.innerHTML = '<option value="">— Select session —</option>' +
    allSessions.map(s => `<option value="${s.id}">${s.name}</option>`).join('')

  // Multi-trial select
  const multiSel = container.querySelector('#an-multi-trial-sel')
  // Will be populated per session
}

function bindEvents(container) {
  container.querySelector('#an-session-sel').addEventListener('change', async (e) => {
    const id = parseInt(e.target.value)
    const trialSel = container.querySelector('#an-trial-sel')
    const multiSel = container.querySelector('#an-multi-trial-sel')
    trialSel.innerHTML = '<option value="">— Select trial —</option>'
    multiSel.innerHTML = ''
    if (!id) return
    const trials = await getTrialsBySession(id)
    const opts = trials.map(t => `<option value="${t.id}">${t.name} (${t.duration?.toFixed(1) ?? '—'}s)</option>`)
    trialSel.innerHTML += opts.join('')
    multiSel.innerHTML  = opts.join('')
    container.querySelector('#an-load-btn').disabled = false
  })

  container.querySelector('#an-trial-sel').addEventListener('change', () => {
    container.querySelector('#an-load-btn').disabled = !container.querySelector('#an-trial-sel').value
  })

  container.querySelector('#an-load-btn').addEventListener('click', () => loadTrial(container))

  container.querySelector('#an-metric-toggles').addEventListener('click', (e) => {
    const btn = e.target.closest('.toggle-chip')
    if (!btn) return
    const key = btn.dataset.metric
    if (activeMetrics.has(key)) activeMetrics.delete(key)
    else activeMetrics.add(key)
    btn.classList.toggle('active')
    renderAnalysis(container)
  })

  container.querySelector('#an-use-custom').addEventListener('click', () => {
    activeGroup = null
    container.querySelectorAll('#an-group-toggles .toggle-chip').forEach(b => b.classList.remove('active'))
    renderAnalysis(container)
  })
  container.querySelector('#an-clear-custom').addEventListener('click', () => {
    customIndices.clear()
    activeGroup = null
    container.querySelectorAll('#an-group-toggles .toggle-chip').forEach(b => b.classList.remove('active'))
    container.querySelectorAll('#an-landmark-checkboxes input').forEach(cb => cb.checked = false)
    renderAnalysis(container)
  })

  container.querySelector('#an-group-analyze').addEventListener('click', () => runGroupAnalysis(container))
  container.querySelector('#an-export-csv').addEventListener('click',   () => exportCurrentCSV())
  container.querySelector('#an-export-video').addEventListener('click', () => exportCurrentVideo())
}

async function loadTrial(container) {
  const trialId = parseInt(container.querySelector('#an-trial-sel').value)
  if (!trialId) return

  currentTrial = await getTrial(trialId)
  if (!currentTrial) return

  currentCalibration = currentTrial.calibrationId
    ? await getCalibration(currentTrial.calibrationId) : null

  const model = currentTrial.model ?? 'pose'
  activeGroup = Object.keys(getGroups(model))[0]

  setupGroupToggles(container, model)
  setupLandmarkCheckboxes(container, model)

  // Sync the initial group's indices into customIndices and check the boxes
  const initialIndices = new Set(getGroups(model)[activeGroup]?.indices ?? [])
  customIndices = new Set(initialIndices)
  container.querySelectorAll('#an-landmark-checkboxes input').forEach(cb => {
    cb.checked = initialIndices.has(parseInt(cb.dataset.idx))
  })

  setupVideoPlayback(container)
  renderAnalysis(container)
  container.querySelector('#an-video-card').style.display = 'block'
  container.querySelector('#an-stats-card').style.display = 'block'
}

// ── Landmark group toggles ────────────────────────────────────

function setupGroupToggles(container, model) {
  const groups = getGroups(model)
  const el = container.querySelector('#an-group-toggles')
  el.innerHTML = Object.keys(groups).map(g => `
    <button class="toggle-chip ${g === activeGroup ? 'active' : ''}" data-group="${g}">
      ${g}
    </button>`).join('')

  el.querySelectorAll('.toggle-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      el.querySelectorAll('.toggle-chip').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      activeGroup = btn.dataset.group

      // Populate customIndices from the group and sync checkboxes
      const groupIndices = new Set(groups[activeGroup]?.indices ?? [])
      customIndices = new Set(groupIndices)
      container.querySelectorAll('#an-landmark-checkboxes input').forEach(cb => {
        cb.checked = groupIndices.has(parseInt(cb.dataset.idx))
      })

      renderAnalysis(container)
    })
  })
}

function setupLandmarkCheckboxes(container, model) {
  const names = getLandmarkNames(model)
  const el = container.querySelector('#an-landmark-checkboxes')
  el.innerHTML = names.map((name, i) => `
    <label style="display:flex;align-items:center;gap:4px;white-space:nowrap">
      <input type="checkbox" data-idx="${i}" /> ${i}:${name.replace('_', ' ')}
    </label>`).join('')

  el.querySelectorAll('input').forEach(cb => {
    cb.addEventListener('change', () => {
      const idx = parseInt(cb.dataset.idx)
      if (cb.checked) customIndices.add(idx)
      else customIndices.delete(idx)
      // Deactivate group chip — user is now in custom mode
      activeGroup = null
      container.querySelectorAll('#an-group-toggles .toggle-chip').forEach(b => b.classList.remove('active'))
      renderAnalysis(container)
    })
  })
}

// ── Video playback with landmark overlay ─────────────────────

function setupVideoPlayback(container) {
  const videoEl   = container.querySelector('#an-video')
  const canvas    = container.querySelector('#an-video-overlay')
  const ctx       = canvas.getContext('2d')

  if (playbackRAF) { cancelAnimationFrame(playbackRAF); playbackRAF = null }

  if (currentTrial?.videoBlob) {
    videoEl.src = URL.createObjectURL(currentTrial.videoBlob)
    videoEl.style.display = ''
  } else {
    videoEl.src = ''
    videoEl.style.display = 'none'
  }

  videoEl.addEventListener('loadedmetadata', () => {
    canvas.width  = videoEl.videoWidth  || 640
    canvas.height = videoEl.videoHeight || 360
  })

  function overlayLoop() {
    playbackRAF = requestAnimationFrame(overlayLoop)
    if (!currentTrial?.landmarkData?.length) return

    const currentMs = videoEl.currentTime * 1000
    const frame = findClosestFrame(currentTrial.landmarkData, currentMs)
    if (!frame) return

    const model = currentTrial.model ?? 'pose'
    drawStoredFrame(ctx, frame, model, canvas.width, canvas.height)
  }
  overlayLoop()
}

function findClosestFrame(landmarkData, ms) {
  if (!landmarkData?.length) return null
  let best = landmarkData[0], bestDiff = Math.abs(best.timestamp - ms)
  for (const f of landmarkData) {
    const d = Math.abs(f.timestamp - ms)
    if (d < bestDiff) { bestDiff = d; best = f }
  }
  return best
}

// ── Analysis rendering ────────────────────────────────────────

function getActiveLandmarkSeries() {
  if (!currentTrial?.landmarkData?.length || !customIndices.size) return null
  const model   = currentTrial.model ?? 'pose'
  const pxPerMm = currentCalibration?.pxPerMm ?? null
  const names   = getLandmarkNames(model)

  return [...customIndices]
    .sort((a, b) => a - b)
    .map(idx => ({
      idx,
      name: `${idx}: ${(names[idx] ?? `lm_${idx}`).replace(/_/g, ' ')}`,
      series: extractLandmarkTimeSeries(currentTrial.landmarkData, idx, pxPerMm),
    }))
    .filter(item => item.series.length >= 2)
}

function renderAnalysis(container) {
  if (!currentTrial) return
  const landmarkSeries = getActiveLandmarkSeries()

  if (!landmarkSeries?.length) {
    container.querySelector('#an-charts-area').innerHTML =
      '<div class="empty-state">Select at least one landmark to display.</div>'
    return
  }

  const chartsArea = container.querySelector('#an-charts-area')
  chartsArea.innerHTML = ''
  Object.values(charts).forEach(c => c.destroy())
  charts = {}

  const unit = currentCalibration ? 'mm' : 'norm'

  for (const mDef of METRIC_DEFS) {
    if (!activeMetrics.has(mDef.key)) continue
    renderMetricChart(chartsArea, landmarkSeries, mDef, unit)
  }

  renderStats(container, landmarkSeries, unit)
}

// Dispatch to line chart or scalar table based on metric type
function renderMetricChart(area, landmarkSeries, mDef, unit) {
  if (mDef.key === 'normjerk' || mDef.key === 'sampentropy' || mDef.key === 'rom') {
    renderScalarTable(area, landmarkSeries, mDef, unit)
  } else {
    renderLineChart(area, landmarkSeries, mDef, unit)
  }
}

// One line per landmark for speed / accel / jerk
function renderLineChart(area, landmarkSeries, mDef, unit) {
  const datasets = []

  for (let i = 0; i < landmarkSeries.length; i++) {
    const { name, series } = landmarkSeries[i]
    let result = { times: [], values: [] }
    if (mDef.key === 'speed') result = computeSpeed(series)
    else if (mDef.key === 'accel') result = computeAcceleration(series)
    else if (mDef.key === 'jerk')  result = computeJerk(series)
    if (!result.values.length) continue

    const color = getColor(i)
    datasets.push({
      label: name,
      data: result.times.map((t, j) => ({ x: t, y: result.values[j] })),
      borderColor: color,
      backgroundColor: 'transparent',
      borderWidth: 1.5,
      pointRadius: 0,
      tension: 0.3,
    })
  }

  if (!datasets.length) return

  const wrap = document.createElement('div')
  wrap.className = 'chart-wrap'
  const canvas = document.createElement('canvas')
  wrap.appendChild(canvas)
  area.appendChild(wrap)

  charts[mDef.key] = new Chart(canvas, {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      animation: false,
      parsing: false,
      plugins: {
        legend: {
          labels: { color: '#e2e8f0', font: { size: 10 }, boxWidth: 12 },
          // Collapse legend when many landmarks to save space
          display: landmarkSeries.length <= 20,
        },
        title: {
          display: true,
          text: `${mDef.label} (${unit}${mDef.unit})`,
          color: '#e2e8f0',
          font: { size: 12 },
        },
      },
      scales: {
        x: {
          type: 'linear',
          ticks: { color: '#8892a4', maxTicksLimit: 10 },
          grid: { color: '#2e3248' },
          title: { display: true, text: 'Time (s)', color: '#8892a4' },
        },
        y: { ticks: { color: '#8892a4' }, grid: { color: '#2e3248' } },
      },
    },
  })
}

// Per-landmark table for scalar metrics (normjerk, sampentropy, rom)
function renderScalarTable(area, landmarkSeries, mDef, unit) {
  const isRom = mDef.key === 'rom'

  const rows = landmarkSeries.map(({ name, series }, i) => {
    const color = getColor(i)
    if (isRom) {
      const rom = computeROM(series)
      return `<tr>
        <td style="color:${color};white-space:nowrap">${name}</td>
        <td>${rom.x.toFixed(3)}</td>
        <td>${rom.y.toFixed(3)}</td>
        <td>${rom.resultant.toFixed(3)}</td>
      </tr>`
    }
    let val = null
    if (mDef.key === 'normjerk') {
      val = computeNormalizedJerk(series)
    } else {
      val = computeSampleEntropy(computeSpeed(series).values)
    }
    return `<tr>
      <td style="color:${color};white-space:nowrap">${name}</td>
      <td colspan="3">${val != null ? val.toFixed(4) : 'N/A'}</td>
    </tr>`
  }).join('')

  const wrap = document.createElement('div')
  wrap.className = 'chart-wrap'
  wrap.innerHTML = `
    <div style="font-size:12px;font-weight:700;color:var(--text-muted);margin-bottom:8px">
      ${mDef.label}
    </div>
    <div style="max-height:220px;overflow-y:auto">
      <table class="stats-table">
        <thead><tr>
          <th>Landmark</th>
          ${isRom
            ? `<th>ROM X (${unit})</th><th>ROM Y (${unit})</th><th>Resultant (${unit})</th>`
            : `<th colspan="3">Value</th>`}
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`
  area.appendChild(wrap)
}

function renderStats(container, landmarkSeries, unit) {
  const statsEl = container.querySelector('#an-stats-content')
  if (!statsEl) return

  const rows = landmarkSeries.map(({ name, series }, i) => {
    const speed = computeSpeed(series)
    const s     = summarize(speed.values)
    const rom   = computeROM(series)
    const color = getColor(i)
    return `<tr>
      <td style="color:${color};white-space:nowrap">${name}</td>
      <td>${s.mean?.toFixed(3) ?? '—'}</td>
      <td>${s.max?.toFixed(3)  ?? '—'}</td>
      <td>${s.std?.toFixed(3)  ?? '—'}</td>
      <td>${((s.cv ?? 0) * 100).toFixed(1)}%</td>
      <td>${rom.x?.toFixed(3)  ?? '—'}</td>
      <td>${rom.y?.toFixed(3)  ?? '—'}</td>
      <td>${rom.resultant?.toFixed(3) ?? '—'}</td>
    </tr>`
  }).join('')

  statsEl.innerHTML = `
    <div style="overflow-x:auto">
      <table class="stats-table">
        <thead><tr>
          <th>Landmark</th>
          <th>Mean Spd</th><th>Peak Spd</th><th>Std Dev</th><th>CV%</th>
          <th>ROM X</th><th>ROM Y</th><th>ROM res.</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div style="font-size:11px;color:var(--text-muted);margin-top:6px">
      Speed unit: ${unit}/s &nbsp;·&nbsp; ROM unit: ${unit} &nbsp;·&nbsp;
      Frames: ${currentTrial.landmarkData?.length ?? 0} &nbsp;·&nbsp;
      Duration: ${currentTrial.duration?.toFixed(1) ?? '—'} s
    </div>`
}

// ── Group analysis ─────────────────────────────────────────────

async function runGroupAnalysis(container) {
  const sel = container.querySelector('#an-multi-trial-sel')
  const selectedIds = [...sel.selectedOptions].map(o => parseInt(o.value))
  if (selectedIds.length < 2) { alert('Select at least 2 trials to compare.'); return }

  const trials = await Promise.all(selectedIds.map(id => getTrial(id)))
  const model  = trials[0]?.model ?? 'pose'
  const groups = getGroups(model)
  const gName  = activeGroup ?? Object.keys(groups)[0]
  const indices = groups[gName]?.indices ?? [0]

  const speedStats = trials.map(trial => {
    const series = extractGroupTimeSeries(trial.landmarkData ?? [], indices, null)
    const speed  = computeSpeed(series)
    return { name: trial.name, ...summarize(speed.values) }
  })

  const area = container.querySelector('#an-group-chart-area')
  area.innerHTML = ''

  // Header bar with clear button
  const header = document.createElement('div')
  header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin:12px 0 4px'
  header.innerHTML = `
    <span style="font-size:12px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em">
      Group Results — ${gName}
    </span>
    <button class="btn btn-ghost btn-sm" id="an-clear-group">← Back to Individual</button>`
  area.appendChild(header)

  header.querySelector('#an-clear-group').addEventListener('click', () => {
    area.innerHTML = ''
    container.querySelector('#an-charts-area').scrollIntoView({ behavior: 'smooth', block: 'start' })
  })

  const wrap = document.createElement('div')
  wrap.className = 'chart-wrap mt-12'
  const canvas = document.createElement('canvas')
  wrap.appendChild(canvas)
  area.appendChild(wrap)

  new Chart(canvas, {
    type: 'bar',
    data: {
      labels: speedStats.map(s => s.name),
      datasets: [
        {
          label: 'Mean Speed',
          data: speedStats.map(s => s.mean ?? 0),
          backgroundColor: '#5b7fff88',
          borderColor: '#5b7fff',
          borderWidth: 1,
        },
        {
          label: 'Peak Speed',
          data: speedStats.map(s => s.max ?? 0),
          backgroundColor: '#3ecf7088',
          borderColor: '#3ecf70',
          borderWidth: 1,
        }
      ]
    },
    options: {
      responsive: true,
      animation: false,
      plugins: {
        legend: { labels: { color: '#e2e8f0' } },
        title: { display: true, text: `Speed Comparison – ${gName}`, color: '#e2e8f0' }
      },
      scales: {
        x: { ticks: { color: '#8892a4' }, grid: { color: '#2e3248' } },
        y: { ticks: { color: '#8892a4' }, grid: { color: '#2e3248' } }
      }
    }
  })

  // Summary table
  const tableWrap = document.createElement('div')
  tableWrap.innerHTML = `
    <table class="stats-table mt-8">
      <thead><tr><th>Trial</th><th>Mean Speed</th><th>Peak Speed</th><th>CV%</th><th>ROM</th></tr></thead>
      <tbody>
        ${speedStats.map(s => `
          <tr>
            <td>${s.name}</td>
            <td>${s.mean?.toFixed(3) ?? '—'}</td>
            <td>${s.max?.toFixed(3)  ?? '—'}</td>
            <td>${((s.cv ?? 0) * 100).toFixed(1)}%</td>
            <td>—</td>
          </tr>`).join('')}
      </tbody>
    </table>`
  area.appendChild(tableWrap)
}

// ── Export ────────────────────────────────────────────────────

function exportCurrentCSV() {
  if (!currentTrial) return
  const csv = exportTrialCSV(currentTrial)
  if (csv) downloadBlob(new Blob([csv], { type: 'text/csv' }), `${currentTrial.name}.csv`)
}

function exportCurrentVideo() {
  if (!currentTrial?.videoBlob) return
  downloadBlob(currentTrial.videoBlob, `${currentTrial.name}.webm`)
}
