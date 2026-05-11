import Chart from 'chart.js/auto'
import { getAllSessions, getTrialsBySession, getTrial, getCalibration, downloadBlob, exportTrialCSV } from '../db.js'
import { getGroups, getLandmarkNames } from '../utils/landmarks.js'
import {
  extractLandmarkTimeSeries, extractGroupTimeSeries,
  computeSpeed, computeAcceleration, computeJerk,
  computeNormalizedJerk, computeSampleEntropy, computeROM,
  summarize, METRIC_DEFS
} from '../utils/metrics.js'
import { drawStoredFrame } from '../utils/mediapipe.js'

let allSessions = []
let currentTrial = null
let currentCalibration = null

let activeMetrics = new Set(['speed'])
let activeGroups  = new Set()     // set of highlighted group chip names (supports multi-select via Shift)
let customIndices = new Set()     // always the source of truth for which landmarks to plot

let charts       = {}
let chartDatasets = {}   // mDef.key → datasets[], for modal re-render
let groupCharts  = {}    // mDef.key → Chart instance for group analysis
let modalChart   = null
let modalEl      = null
let playbackRAF  = null
let groupAnalysisShowing = false

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
    if (groupAnalysisShowing) runGroupAnalysis(container)
  })

  container.querySelector('#an-use-custom').addEventListener('click', () => {
    activeGroups = new Set()
    container.querySelectorAll('#an-group-toggles .toggle-chip').forEach(b => b.classList.remove('active'))
    renderAnalysis(container)
  })
  container.querySelector('#an-clear-custom').addEventListener('click', () => {
    customIndices.clear()
    activeGroups = new Set()
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
  activeGroups = new Set([Object.keys(getGroups(model))[0]])

  setupGroupToggles(container, model)
  setupLandmarkCheckboxes(container, model)

  // Sync the initial group's indices into customIndices and check the boxes
  customIndices = groupUnion(getGroups(model))
  container.querySelectorAll('#an-landmark-checkboxes input').forEach(cb => {
    cb.checked = customIndices.has(parseInt(cb.dataset.idx))
  })

  setupVideoPlayback(container)
  renderAnalysis(container)
  container.querySelector('#an-video-card').style.display = 'block'
  container.querySelector('#an-stats-card').style.display = 'block'
}

// ── Landmark group toggles ────────────────────────────────────

// Returns union of indices across all currently active group names.
function groupUnion(groups) {
  const result = new Set()
  for (const name of activeGroups) {
    for (const idx of (groups[name]?.indices ?? [])) result.add(idx)
  }
  return result
}

function setupGroupToggles(container, model) {
  const groups = getGroups(model)
  const el = container.querySelector('#an-group-toggles')
  el.innerHTML = Object.keys(groups).map(g => `
    <button class="toggle-chip ${activeGroups.has(g) ? 'active' : ''}" data-group="${g}"
            title="Click to select · Shift+click to add/remove">
      ${g}
    </button>`).join('')

  el.querySelectorAll('.toggle-chip').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const name = btn.dataset.group
      if (e.shiftKey) {
        // Toggle this group in/out of the active set without disturbing others
        if (activeGroups.has(name)) activeGroups.delete(name)
        else activeGroups.add(name)
        btn.classList.toggle('active', activeGroups.has(name))
      } else {
        // Normal click: exclusive selection
        el.querySelectorAll('.toggle-chip').forEach(b => b.classList.remove('active'))
        btn.classList.add('active')
        activeGroups = new Set([name])
      }

      // Recompute customIndices as the union of all active groups
      customIndices = groupUnion(groups)
      container.querySelectorAll('#an-landmark-checkboxes input').forEach(cb => {
        cb.checked = customIndices.has(parseInt(cb.dataset.idx))
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
      // Deactivate group chips — user is now in custom mode
      activeGroups = new Set()
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
  chartDatasets = {}
  closeModal()

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

// Shared Chart.js config builder — used for both inline and modal charts
function buildLineChartConfig(datasets, mDef, unit, { modal = false } = {}) {
  return {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: !modal,
      animation: false,
      parsing: false,
      plugins: {
        legend: {
          labels: { color: '#e2e8f0', font: { size: modal ? 12 : 10 }, boxWidth: 12 },
          display: datasets.length <= (modal ? 33 : 20),
        },
        title: {
          display: true,
          text: `${mDef.label} (${unit}${mDef.unit})`,
          color: '#e2e8f0',
          font: { size: modal ? 15 : 12 },
        },
      },
      scales: {
        x: {
          type: 'linear',
          ticks: { color: '#8892a4', maxTicksLimit: modal ? 15 : 10 },
          grid: { color: '#2e3248' },
          title: { display: true, text: 'Time (s)', color: '#8892a4' },
        },
        y: { ticks: { color: '#8892a4' }, grid: { color: '#2e3248' } },
      },
    },
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

    datasets.push({
      label: name,
      data: result.times.map((t, j) => ({ x: t, y: result.values[j] })),
      borderColor: getColor(i),
      backgroundColor: 'transparent',
      borderWidth: 1.5,
      pointRadius: 0,
      tension: 0.3,
    })
  }

  if (!datasets.length) return
  chartDatasets[mDef.key] = datasets   // store for modal re-render

  const wrap = document.createElement('div')
  wrap.className = 'chart-wrap'

  // Button row: Expand + PNG
  const btnRow = document.createElement('div')
  btnRow.style.cssText = 'display:flex;justify-content:flex-end;gap:6px;margin-bottom:4px'

  const expandBtn = document.createElement('button')
  expandBtn.className = 'btn btn-ghost btn-sm'
  expandBtn.textContent = '⛶ Expand'
  expandBtn.style.fontSize = '11px'
  expandBtn.addEventListener('click', () => openModal(mDef, unit))

  const dlBtn = document.createElement('button')
  dlBtn.className = 'btn btn-ghost btn-sm'
  dlBtn.textContent = '⬇ PNG'
  dlBtn.style.fontSize = '11px'
  dlBtn.addEventListener('click', () => {
    const chart = charts[mDef.key]
    if (!chart) return
    const tmp = document.createElement('canvas')
    tmp.width  = chart.canvas.width
    tmp.height = chart.canvas.height
    const tCtx = tmp.getContext('2d')
    tCtx.fillStyle = '#1a1f2e'
    tCtx.fillRect(0, 0, tmp.width, tmp.height)
    tCtx.drawImage(chart.canvas, 0, 0)
    const a = document.createElement('a')
    a.href     = tmp.toDataURL('image/png')
    a.download = `${currentTrial?.name ?? 'trial'}_${mDef.key}.png`
    a.click()
  })

  btnRow.appendChild(expandBtn)
  btnRow.appendChild(dlBtn)
  wrap.appendChild(btnRow)

  const canvas = document.createElement('canvas')
  wrap.appendChild(canvas)
  area.appendChild(wrap)

  charts[mDef.key] = new Chart(canvas, buildLineChartConfig(datasets, mDef, unit))
}

// ── Chart modal (full-screen expand) ─────────────────────────

function getOrCreateModal() {
  if (modalEl) return modalEl

  modalEl = document.createElement('div')
  modalEl.style.cssText = `
    display:none; position:fixed; inset:0; z-index:9999;
    background:rgba(0,0,0,.88);
    align-items:center; justify-content:center;`

  const inner = document.createElement('div')
  inner.style.cssText = `
    position:relative; width:94vw; height:88vh;
    background:#1a1f2e; border-radius:10px;
    padding:48px 24px 24px;
    display:flex; flex-direction:column;`

  const closeBtn = document.createElement('button')
  closeBtn.className = 'btn btn-ghost btn-sm'
  closeBtn.textContent = '✕ Close'
  closeBtn.style.cssText = 'position:absolute;top:12px;right:12px'
  closeBtn.addEventListener('click', closeModal)

  const modalCanvas = document.createElement('canvas')
  modalCanvas.id = 'an-modal-canvas'
  modalCanvas.style.cssText = 'flex:1;min-height:0;'

  inner.appendChild(closeBtn)
  inner.appendChild(modalCanvas)
  modalEl.appendChild(inner)
  document.body.appendChild(modalEl)

  // Close on backdrop click or Escape key
  modalEl.addEventListener('click', e => { if (e.target === modalEl) closeModal() })
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal() })

  return modalEl
}

function openModal(mDef, unit) {
  const datasets = chartDatasets[mDef.key]
  if (!datasets?.length) return

  const modal = getOrCreateModal()
  modal.style.display = 'flex'

  if (modalChart) { modalChart.destroy(); modalChart = null }
  const canvas = modal.querySelector('#an-modal-canvas')
  modalChart = new Chart(canvas, buildLineChartConfig(datasets, mDef, unit, { modal: true }))
}

function closeModal() {
  if (modalEl)   modalEl.style.display = 'none'
  if (modalChart) { modalChart.destroy(); modalChart = null }
}

function openModalWithConfig(config) {
  const modal = getOrCreateModal()
  modal.style.display = 'flex'
  if (modalChart) { modalChart.destroy(); modalChart = null }
  const canvas = modal.querySelector('#an-modal-canvas')
  modalChart = new Chart(canvas, config)
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

  const dlBtn = document.createElement('button')
  dlBtn.className = 'btn btn-ghost btn-sm mt-8'
  dlBtn.textContent = '⬇ Download Stats CSV'
  dlBtn.addEventListener('click', () => downloadStatsCsv(landmarkSeries, unit))
  statsEl.appendChild(dlBtn)
}

function downloadStatsCsv(landmarkSeries, unit) {
  const header = [
    'Landmark',
    `Mean Speed (${unit}/s)`, `Peak Speed (${unit}/s)`,
    `Std Dev (${unit}/s)`, 'CV%',
    `ROM X (${unit})`, `ROM Y (${unit})`, `ROM Resultant (${unit})`,
    'Norm. Jerk (log)', 'Sample Entropy',
  ]

  const dataRows = landmarkSeries.map(({ name, series }) => {
    const speed = computeSpeed(series)
    const s     = summarize(speed.values)
    const rom   = computeROM(series)
    const nj    = computeNormalizedJerk(series)
    const se    = computeSampleEntropy(speed.values)
    return [
      name,
      s.mean?.toFixed(4)         ?? '',
      s.max?.toFixed(4)          ?? '',
      s.std?.toFixed(4)          ?? '',
      ((s.cv ?? 0) * 100).toFixed(2),
      rom.x?.toFixed(4)          ?? '',
      rom.y?.toFixed(4)          ?? '',
      rom.resultant?.toFixed(4)  ?? '',
      nj != null ? nj.toFixed(4) : '',
      se != null ? se.toFixed(4) : '',
    ]
  })

  const csv = [header, ...dataRows]
    .map(r => r.map(v => `"${v}"`).join(','))
    .join('\n')

  const trialName = currentTrial?.name ?? 'trial'
  downloadBlob(new Blob([csv], { type: 'text/csv' }), `${trialName}_stats.csv`)
}

// ── Group analysis (Compare Trials) ───────────────────────────

async function runGroupAnalysis(container) {
  const sel = container.querySelector('#an-multi-trial-sel')
  const selectedIds = [...sel.selectedOptions].map(o => parseInt(o.value))
  if (selectedIds.length < 2) { alert('Select at least 2 trials to compare.'); return }
  if (!customIndices.size) {
    alert('Select a Landmark Group or Custom Landmarks on the right panel first.')
    return
  }
  groupAnalysisShowing = true
  Object.values(groupCharts).forEach(c => { try { c.destroy() } catch (_) {} })
  groupCharts = {}

  const trials  = await Promise.all(selectedIds.map(id => getTrial(id)))
  const indices = [...customIndices].sort((a, b) => a - b)

  // Label describing the current landmark selection
  const groupLabel = activeGroups.size ? [...activeGroups].join(' + ') : 'Custom selection'
  const selectionLabel = `${groupLabel} — centroid of ${indices.length} landmark${indices.length > 1 ? 's' : ''}`

  // Compute centroid time series per trial (no calibration — trials may differ)
  const trialColors = trials.map((_, i) => getColor(i))
  const trialSeries = trials.map((trial, i) => ({
    name:   trial.name,
    color:  trialColors[i],
    series: extractGroupTimeSeries(trial.landmarkData ?? [], indices, null),
  }))

  const area = container.querySelector('#an-group-chart-area')
  area.innerHTML = ''

  // Header
  const header = document.createElement('div')
  header.style.cssText = 'margin:12px 0 10px'
  header.innerHTML = `
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px">
      <div>
        <div style="font-size:12px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em">
          Trial Comparison
        </div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:3px">
          Landmark: <em style="color:var(--text)">${selectionLabel}</em>
        </div>
      </div>
      <button class="btn btn-ghost btn-sm" id="an-clear-group">← Back</button>
    </div>`
  area.appendChild(header)
  header.querySelector('#an-clear-group').addEventListener('click', () => { area.innerHTML = ''; groupAnalysisShowing = false })

  // One chart per active metric
  for (const mDef of METRIC_DEFS) {
    if (!activeMetrics.has(mDef.key)) continue
    if (mDef.key === 'normjerk' || mDef.key === 'sampentropy' || mDef.key === 'rom') {
      renderGroupScalarChart(area, trialSeries, mDef)
    } else {
      renderGroupLineChart(area, trialSeries, mDef)
    }
  }

  // Summary stats table
  renderGroupStatsTable(area, trialSeries)
}

// Overlaid time-series line chart — one line per trial
function renderGroupLineChart(area, trialSeries, mDef) {
  const datasets = trialSeries.map(({ name, color, series }) => {
    let result = { times: [], values: [] }
    if (mDef.key === 'speed') result = computeSpeed(series)
    else if (mDef.key === 'accel') result = computeAcceleration(series)
    else if (mDef.key === 'jerk')  result = computeJerk(series)
    if (!result.values.length) return null
    return {
      label: name,
      data: result.times.map((t, j) => ({ x: t, y: result.values[j] })),
      borderColor: color,
      backgroundColor: 'transparent',
      borderWidth: 1.5,
      pointRadius: 0,
      tension: 0.3,
    }
  }).filter(Boolean)

  if (!datasets.length) return

  const buildConfig = ({ modal = false } = {}) => ({
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: !modal,
      animation: false,
      parsing: false,
      plugins: {
        legend: { labels: { color: '#e2e8f0', font: { size: modal ? 12 : 11 }, boxWidth: 12 } },
        title: { display: true, text: `${mDef.label} (norm${mDef.unit}) — centroid`, color: '#e2e8f0', font: { size: modal ? 15 : 12 } },
      },
      scales: {
        x: { type: 'linear', ticks: { color: '#8892a4', maxTicksLimit: modal ? 15 : 10 }, grid: { color: '#2e3248' },
             title: { display: true, text: 'Time (s)', color: '#8892a4' } },
        y: { ticks: { color: '#8892a4' }, grid: { color: '#2e3248' } },
      },
    },
  })

  const wrap = document.createElement('div')
  wrap.className = 'chart-wrap mt-8'

  const btnRow = document.createElement('div')
  btnRow.style.cssText = 'display:flex;justify-content:flex-end;gap:6px;margin-bottom:4px'

  const expandBtn = document.createElement('button')
  expandBtn.className = 'btn btn-ghost btn-sm'
  expandBtn.textContent = '⛶ Expand'
  expandBtn.style.fontSize = '11px'
  expandBtn.addEventListener('click', () => openModalWithConfig(buildConfig({ modal: true })))

  const dlBtn = document.createElement('button')
  dlBtn.className = 'btn btn-ghost btn-sm'
  dlBtn.textContent = '⬇ PNG'
  dlBtn.style.fontSize = '11px'
  dlBtn.addEventListener('click', () => {
    const chart = groupCharts[mDef.key]
    if (!chart) return
    const tmp = document.createElement('canvas')
    tmp.width  = chart.canvas.width
    tmp.height = chart.canvas.height
    const tCtx = tmp.getContext('2d')
    tCtx.fillStyle = '#1a1f2e'
    tCtx.fillRect(0, 0, tmp.width, tmp.height)
    tCtx.drawImage(chart.canvas, 0, 0)
    const a = document.createElement('a')
    a.href     = tmp.toDataURL('image/png')
    a.download = `compare_${mDef.key}.png`
    a.click()
  })

  btnRow.appendChild(expandBtn)
  btnRow.appendChild(dlBtn)
  wrap.appendChild(btnRow)

  const canvas = document.createElement('canvas')
  wrap.appendChild(canvas)
  area.appendChild(wrap)

  groupCharts[mDef.key] = new Chart(canvas, buildConfig())
}

// Bar chart for scalar metrics (normjerk, sampentropy, rom)
function renderGroupScalarChart(area, trialSeries, mDef) {
  const values = trialSeries.map(({ series }) => {
    if (mDef.key === 'normjerk')    return computeNormalizedJerk(series) ?? 0
    if (mDef.key === 'sampentropy') return computeSampleEntropy(computeSpeed(series).values) ?? 0
    if (mDef.key === 'rom')         return computeROM(series).resultant ?? 0
    return 0
  })

  const buildConfig = ({ modal = false } = {}) => ({
    type: 'bar',
    data: {
      labels: trialSeries.map(t => t.name),
      datasets: [{
        label: mDef.label,
        data: values,
        backgroundColor: trialSeries.map(t => t.color + '88'),
        borderColor:     trialSeries.map(t => t.color),
        borderWidth: 1,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: !modal,
      animation: false,
      plugins: {
        legend: { labels: { color: '#e2e8f0' } },
        title: { display: true, text: `${mDef.label} — centroid`, color: '#e2e8f0', font: { size: modal ? 15 : 12 } },
      },
      scales: {
        x: { ticks: { color: '#8892a4' }, grid: { color: '#2e3248' } },
        y: { ticks: { color: '#8892a4' }, grid: { color: '#2e3248' } },
      },
    },
  })

  const wrap = document.createElement('div')
  wrap.className = 'chart-wrap mt-8'

  const btnRow = document.createElement('div')
  btnRow.style.cssText = 'display:flex;justify-content:flex-end;gap:6px;margin-bottom:4px'

  const expandBtn = document.createElement('button')
  expandBtn.className = 'btn btn-ghost btn-sm'
  expandBtn.textContent = '⛶ Expand'
  expandBtn.style.fontSize = '11px'
  expandBtn.addEventListener('click', () => openModalWithConfig(buildConfig({ modal: true })))

  const dlBtn = document.createElement('button')
  dlBtn.className = 'btn btn-ghost btn-sm'
  dlBtn.textContent = '⬇ PNG'
  dlBtn.style.fontSize = '11px'
  dlBtn.addEventListener('click', () => {
    const chart = groupCharts[mDef.key]
    if (!chart) return
    const tmp = document.createElement('canvas')
    tmp.width  = chart.canvas.width
    tmp.height = chart.canvas.height
    const tCtx = tmp.getContext('2d')
    tCtx.fillStyle = '#1a1f2e'
    tCtx.fillRect(0, 0, tmp.width, tmp.height)
    tCtx.drawImage(chart.canvas, 0, 0)
    const a = document.createElement('a')
    a.href     = tmp.toDataURL('image/png')
    a.download = `compare_${mDef.key}.png`
    a.click()
  })

  btnRow.appendChild(expandBtn)
  btnRow.appendChild(dlBtn)
  wrap.appendChild(btnRow)

  const canvas = document.createElement('canvas')
  wrap.appendChild(canvas)
  area.appendChild(wrap)

  groupCharts[mDef.key] = new Chart(canvas, buildConfig())
}

// Summary stats table across all trials
function renderGroupStatsTable(area, trialSeries) {
  const rows = trialSeries.map(({ name, color, series }) => {
    const speed = computeSpeed(series)
    const s   = summarize(speed.values)
    const rom = computeROM(series)
    const nj  = computeNormalizedJerk(series)
    const se  = computeSampleEntropy(speed.values)
    return `<tr>
      <td style="color:${color};white-space:nowrap">${name}</td>
      <td>${s.mean?.toFixed(3) ?? '—'}</td>
      <td>${s.max?.toFixed(3)  ?? '—'}</td>
      <td>${s.std?.toFixed(3)  ?? '—'}</td>
      <td>${((s.cv ?? 0) * 100).toFixed(1)}%</td>
      <td>${rom.resultant?.toFixed(3) ?? '—'}</td>
      <td>${nj != null ? nj.toFixed(3) : '—'}</td>
      <td>${se != null ? se.toFixed(3) : '—'}</td>
    </tr>`
  }).join('')

  const wrap = document.createElement('div')
  wrap.className = 'mt-8'
  wrap.innerHTML = `
    <div style="overflow-x:auto">
      <table class="stats-table">
        <thead><tr>
          <th>Trial</th>
          <th>Mean Spd</th><th>Peak Spd</th><th>Std Dev</th><th>CV%</th>
          <th>ROM res.</th><th>Norm. Jerk</th><th>Samp. Entropy</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div style="font-size:11px;color:var(--text-muted);margin-top:6px">
      Values in normalized coordinates · centroid of selected landmarks
    </div>`
  area.appendChild(wrap)
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
