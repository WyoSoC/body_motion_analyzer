'use strict'

// Calib worker: checkerboard detection (OpenCV WASM) + ChArUco detection (js-aruco2 pure JS).

importScripts('./opencv.js')
importScripts('./js-aruco2.js')

// ── OpenCV WASM init ──────────────────────────────────────────────────────────

function onCvReady() {
  self.cv = cv
}

if (cv && cv.Mat) {
  onCvReady()
} else {
  cv['onRuntimeInitialized'] = onCvReady
}

let busy = false

// ── js-aruco2 detector (lazy init) ───────────────────────────────────────────

let _arucoDetector = null
function getArucoDetector() {
  if (!_arucoDetector)
    _arucoDetector = new AR.Detector({ dictionaryName: 'ARUCO_4X4_1000' })
  return _arucoDetector
}

// ── Message router ────────────────────────────────────────────────────────────

self.onmessage = function(e) {
  const { type, camId } = e.data

  if (type !== 'detect' && type !== 'detect-charuco') return

  if (busy || !self.cv?.Mat) { self.postMessage({ type: 'miss', camId }); return }
  busy = true

  if (type === 'detect-charuco') { detectCharuco(e.data); return }

  // ── Checkerboard detection via cv.findChessboardCorners ──────────────────
  const { buffer, width, height, board } = e.data
  const mats = []
  const track = m => { mats.push(m); return m }

  try {
    const cv = self.cv
    const { cols, rows } = board
    const N = cols * rows

    const src  = track(cv.matFromImageData(new ImageData(new Uint8ClampedArray(buffer), width, height)))
    const gray = track(new cv.Mat())
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)

    const cornerMat = track(new cv.Mat())
    const found = cv.findChessboardCorners(
      gray, new cv.Size(cols, rows), cornerMat,
      cv.CALIB_CB_ADAPTIVE_THRESH + cv.CALIB_CB_NORMALIZE_IMAGE + cv.CALIB_CB_FAST_CHECK
    )

    if (!found) {
      self.postMessage({ type: 'miss', camId })
      return
    }

    const winSize  = new cv.Size(5, 5)
    const zeroZone = new cv.Size(-1, -1)
    const criteria = new cv.TermCriteria(cv.TermCriteria_EPS + cv.TermCriteria_MAX_ITER, 30, 0.1)
    cv.cornerSubPix(gray, cornerMat, winSize, zeroZone, criteria)

    const result = []
    for (let i = 0; i < N; i++)
      result.push([cornerMat.data32F[i*2], cornerMat.data32F[i*2+1]])

    self.postMessage({ type: 'result', corners: result, camId })

  } catch(err) {
    console.error('[calib-worker]', err)
    self.postMessage({ type: 'miss', camId })
  } finally {
    mats.forEach(m => { try { m.delete() } catch(_) {} })
    busy = false
  }
}

// ── ChArUco detection via js-aruco2 + JS homography ──────────────────────────

function solveLinear8x8(A, rhs) {
  const n = 8
  const M = A.map((row, i) => [...row, rhs[i]])

  for (let col = 0; col < n; col++) {
    let maxRow = col
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(M[row][col]) > Math.abs(M[maxRow][col])) maxRow = row
    }
    ;[M[col], M[maxRow]] = [M[maxRow], M[col]]
    if (Math.abs(M[col][col]) < 1e-10) throw new Error('Singular homography')
    for (let row = col + 1; row < n; row++) {
      const f = M[row][col] / M[col][col]
      for (let j = col; j <= n; j++) M[row][j] -= f * M[col][j]
    }
  }

  const x = new Array(n)
  for (let i = n - 1; i >= 0; i--) {
    x[i] = M[i][n]
    for (let j = i + 1; j < n; j++) x[i] -= M[i][j] * x[j]
    x[i] /= M[i][i]
  }
  return x
}

function computeHomography(srcPts, dstPts) {
  const A = [], b = []
  for (let i = 0; i < 4; i++) {
    const [X, Y] = srcPts[i], [u, v] = dstPts[i]
    A.push([X, Y, 1, 0, 0, 0, -u*X, -u*Y]); b.push(u)
    A.push([0, 0, 0, X, Y, 1, -v*X, -v*Y]); b.push(v)
  }
  const h = solveLinear8x8(A, b)
  return [[h[0],h[1],h[2]],[h[3],h[4],h[5]],[h[6],h[7],1]]
}

function projectPoint(H, X, Y) {
  const w = H[2][0]*X + H[2][1]*Y + H[2][2]
  return [(H[0][0]*X + H[0][1]*Y + H[0][2]) / w,
          (H[1][0]*X + H[1][1]*Y + H[1][2]) / w]
}

function detectCharuco({ buffer, width, height, board: bp, camId }) {
  try {
    const { cols, rows, squareMm } = bp
    const markerMm = squareMm * 0.75
    const margin   = (squareMm - markerMm) / 2
    const innerCols = cols - 1
    const innerRows = rows - 1

    // Map: marker ordinal ID → board square (c, r)
    const markerToSquare = {}
    let m = 0
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++)
        if ((c + r) % 2 === 0) markerToSquare[m++] = { c, r }
    const numMarkers = m

    const imageData = { width, height, data: new Uint8ClampedArray(buffer) }
    const markers   = getArucoDetector().detect(imageData)

    if (!markers.length) { self.postMessage({ type: 'miss', camId }); return }

    // Accumulate inner-corner image estimates from each visible marker.
    // Board calibration coords: inner corner (ic, ir) = (ic*squareMm, ir*squareMm),
    // matching calib_math.js `charucoIdToPoint`.
    const accum = {}  // cornerID → { sx, sy, n }

    for (const marker of markers) {
      if (marker.id >= numMarkers) continue
      const { c, r } = markerToSquare[marker.id]

      // Marker corners in board calibration coords (TL→TR→BR→BL, clockwise)
      const c1 = (c - 1) * squareMm + margin
      const c2 =  c      * squareMm - margin
      const r1 = (r - 1) * squareMm + margin
      const r2 =  r      * squareMm - margin
      const boardPts = [[c1,r1],[c2,r1],[c2,r2],[c1,r2]]

      // Detected image corners from js-aruco2 ({x,y}, TL-first clockwise)
      const imgPts = marker.corners.map(pt => [pt.x, pt.y])

      let H
      try { H = computeHomography(boardPts, imgPts) } catch { continue }

      // Project the (up to 4) adjacent inner corners through H
      for (const [ic, ir] of [[c-1,r-1],[c,r-1],[c-1,r],[c,r]]) {
        if (ic < 0 || ir < 0 || ic >= innerCols || ir >= innerRows) continue
        const id = ir * innerCols + ic
        const [px, py] = projectPoint(H, ic * squareMm, ir * squareMm)
        if (!accum[id]) accum[id] = { sx: 0, sy: 0, n: 0 }
        accum[id].sx += px; accum[id].sy += py; accum[id].n++
      }
    }

    const corners = [], ids = []
    for (const [idStr, { sx, sy, n }] of Object.entries(accum)) {
      corners.push([sx / n, sy / n])
      ids.push(parseInt(idStr))
    }

    if (corners.length < 4) { self.postMessage({ type: 'miss', camId }); return }

    self.postMessage({ type: 'charuco-result', corners, ids, camId })

  } catch (err) {
    console.error('[calib-worker charuco]', err)
    self.postMessage({ type: 'miss', camId })
  } finally {
    busy = false
  }
}
