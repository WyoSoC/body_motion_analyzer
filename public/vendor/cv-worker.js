'use strict';

importScripts('./opencv.js');

if (cv && cv.Mat) {
  self.cv = cv
  self.postMessage({ type: 'ready' })
} else {
  cv['onRuntimeInitialized'] = () => {
    self.cv = cv
    self.postMessage({ type: 'ready' })
  }
}

let busy = false

self.onmessage = function (e) {
  const { type, buffer, width, height, cols, rows } = e.data
  if (type !== 'detect' || busy || !self.cv?.Mat) return
  busy = true

  const mats = []
  const track = (m) => { mats.push(m); return m }

  try {
    const cv = self.cv
    const imageData = new ImageData(new Uint8ClampedArray(buffer), width, height)
    const src  = track(cv.matFromImageData(imageData))
    const gray = track(new cv.Mat())
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)

    // Downscale to max 640px wide for speed
    const scale = Math.min(1, 640 / width)
    let detect = gray
    if (scale < 1) {
      detect = track(new cv.Mat())
      const dsize = new cv.Size(Math.round(width * scale), Math.round(height * scale))
      cv.resize(gray, detect, dsize, 0, 0, cv.INTER_AREA)
    }

    // ── Square detection (replaces findChessboardCorners) ──────
    // Adaptive threshold block size: roughly 2× expected square size,
    // using 1/12 of the shorter image dimension as a proxy for square size.
    const shortSide = Math.min(detect.rows, detect.cols)
    const bk = Math.max(11, 2 * Math.round(shortSide / 12) + 1)

    const blurred = track(new cv.Mat())
    cv.GaussianBlur(detect, blurred, new cv.Size(5, 5), 0)

    const binary = track(new cv.Mat())
    cv.adaptiveThreshold(
      blurred, binary, 255,
      cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY_INV,
      bk, 5
    )

    const contours  = track(new cv.MatVector())
    const hierarchy = track(new cv.Mat())
    cv.findContours(binary, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)

    const imgArea = detect.rows * detect.cols
    const minArea = imgArea * 0.00005   // tiny noise threshold
    const maxArea = imgArea * 0.04      // no single square > 4% of frame

    const candidates = []
    for (let i = 0; i < contours.size(); i++) {
      const cnt  = contours.get(i)
      const area = cv.contourArea(cnt)
      cnt.delete()

      if (area < minArea || area > maxArea) continue

      // Re-fetch contour for polygon approximation
      const c2   = contours.get(i)
      const peri = cv.arcLength(c2, true)
      const approx = new cv.Mat()
      cv.approxPolyDP(c2, approx, 0.05 * peri, true)
      c2.delete()

      if (approx.rows === 4 && cv.isContourConvex(approx)) {
        // Re-fetch bounding rect from a fresh contour get
        const c3  = contours.get(i)
        const rct = cv.boundingRect(c3)
        c3.delete()
        const ar = rct.width / rct.height
        if (ar > 0.4 && ar < 2.5) {
          candidates.push({
            area,
            cx: rct.x + rct.width  / 2,
            cy: rct.y + rct.height / 2,
            side: Math.sqrt(area),
          })
        }
      }
      approx.delete()
    }

    const minSquares = Math.floor((cols * rows) / 2 * 0.5)   // need at least half the expected black squares
    if (candidates.length < Math.max(5, minSquares)) {
      self.postMessage({ type: 'miss' })
      return
    }

    // Cluster by area — keep squares near the median
    const sorted = [...candidates].sort((a, b) => a.area - b.area)
    const medianArea = sorted[Math.floor(sorted.length / 2)].area
    const kept = candidates.filter(s => Math.abs(s.area - medianArea) / medianArea < 0.4)

    if (kept.length < Math.max(5, minSquares)) {
      self.postMessage({ type: 'miss' })
      return
    }

    const avgSide    = kept.reduce((s, c) => s + c.side, 0) / kept.length
    const avgPx      = avgSide / scale                        // back to original-resolution pixels
    const cornerData = kept.flatMap(c => [c.cx / scale, c.cy / scale])

    self.postMessage({ type: 'result', corners: cornerData, avgPx })
  } catch (err) {
    console.error('[cv-worker] detection error:', err)
    self.postMessage({ type: 'miss' })
  } finally {
    mats.forEach(m => { try { m.delete() } catch (_) {} })
    busy = false
  }
}
