// Board PDF download helpers.
// jsPDF is loaded dynamically on first use to keep the initial bundle lean.

// DICT_4X4_50: first 50 entries of OpenCV's ARUCO_4X4_1000 dictionary.
// Each entry [b0, b1] encodes a 4×4 bit grid (MSB-first, row-major).
const DICT_4X4_50 = [
  [181,50],[15,154],[51,45],[153,70],[84,158],[121,205],[158,46],[196,242],
  [254,218],[207,86],[249,145],[17,167],[14,183],[42,15],[36,177],[38,62],
  [70,101],[102,0],[108,94],[118,175],[134,139],[176,43],[204,213],[221,130],
  [254,71],[148,113],[172,228],[165,84],[33,35],[52,111],[68,21],[87,178],
  [158,207],[240,203],[8,174],[9,41],[24,117],[4,255],[13,246],[28,90],
  [23,24],[42,40],[50,140],[56,178],[36,232],[46,235],[45,63],[75,100],
  [80,46],[80,19],
]

// ── Canvas renderers ──────────────────────────────────────────────────────────

function renderCheckerboard(squareCols, squareRows, squareMm, dpi = 300) {
  const px = mm => Math.round(mm * dpi / 25.4)
  const sq = px(squareMm)
  const canvas = document.createElement('canvas')
  canvas.width  = squareCols * sq
  canvas.height = squareRows * sq
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#000'
  for (let r = 0; r < squareRows; r++)
    for (let c = 0; c < squareCols; c++)
      if ((c + r) % 2 === 1) ctx.fillRect(c * sq, r * sq, sq, sq)
  return canvas
}

function markerBits(id) {
  const [b0, b1] = DICT_4X4_50[id]
  return (b0.toString(2).padStart(8, '0') + b1.toString(2).padStart(8, '0'))
    .split('').map(Number)
}

function drawMarker(ctx, sx, sy, squarePx, markerPx, id) {
  const bits = markerBits(id)
  const cell = markerPx / 6
  const ox = sx + (squarePx - markerPx) / 2
  const oy = sy + (squarePx - markerPx) / 2
  ctx.fillStyle = '#000'
  ctx.fillRect(ox, oy, markerPx, markerPx)
  ctx.fillStyle = '#fff'
  for (let row = 0; row < 4; row++)
    for (let col = 0; col < 4; col++)
      if (bits[row * 4 + col] === 1)
        ctx.fillRect(ox + (col + 1) * cell, oy + (row + 1) * cell, cell, cell)
}

function renderCharucoBoard(cols, rows, squareMm, dpi = 300) {
  const numMarkers = cols * rows - Math.floor(cols * rows / 2)
  if (numMarkers > DICT_4X4_50.length)
    throw new Error(`Board needs ${numMarkers} markers but DICT_4X4_50 only has 50`)
  const px = mm => Math.round(mm * dpi / 25.4)
  const sq = px(squareMm)
  const markerPx = px(squareMm * 0.75)
  const canvas = document.createElement('canvas')
  canvas.width  = cols * sq
  canvas.height = rows * sq
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  let markerId = 0
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      if ((c + r) % 2 === 1) {
        ctx.fillStyle = '#000'
        ctx.fillRect(c * sq, r * sq, sq, sq)
      } else if (markerId < DICT_4X4_50.length) {
        drawMarker(ctx, c * sq, r * sq, sq, markerPx, markerId++)
      }
  return canvas
}

// ── Shared PDF builder ────────────────────────────────────────────────────────

const PAGE_W_MM = 279.4   // US Letter landscape
const PAGE_H_MM = 215.9
const MARGIN_MM = 20      // generous margin on all sides
const TEXT_RESERVE_MM = 32 // scale bar (2) + gaps + 3 text lines ≈ 30 mm

async function savePDF({ canvas, boardWidthMm, boardHeightMm, squareMm, title, infoLines, filename }) {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ unit: 'mm', format: 'letter', orientation: 'landscape' })

  const availW = PAGE_W_MM - 2 * MARGIN_MM
  const availH = PAGE_H_MM - 2 * MARGIN_MM - TEXT_RESERVE_MM

  // Keep board at correct physical size; scale down only if it won't fit
  let bw = boardWidthMm, bh = boardHeightMm, scaled = false
  if (bw > availW || bh > availH) {
    const s = Math.min(availW / bw, availH / bh)
    bw *= s; bh *= s; scaled = true
  }

  const bx = MARGIN_MM + (availW - bw) / 2
  const by = MARGIN_MM + (availH - bh) / 2

  doc.addImage(canvas.toDataURL('image/png'), 'PNG', bx, by, bw, bh)

  // Scale bar — one square wide, 2 mm tall
  const scaleBarW = (squareMm / boardWidthMm) * bw
  const barY = by + bh + 5
  doc.setFillColor(0, 0, 0)
  doc.rect(bx, barY, scaleBarW, 2, 'F')

  // Info block
  doc.setFontSize(8.5)
  doc.setTextColor(50, 50, 50)
  let ty = barY + 6
  doc.setFont(undefined, 'bold')
  doc.text(title, PAGE_W_MM / 2, ty, { align: 'center' })
  ty += 4
  doc.setFont(undefined, 'normal')
  for (const line of infoLines) {
    doc.text(line, PAGE_W_MM / 2, ty, { align: 'center' })
    ty += 3.8
  }
  const note = scaled
    ? `Scale bar = ${squareMm} mm (board scaled to fit — verify with scale bar before use).`
    : `The black bar above = one square (${squareMm} mm).  Print at 100 % scale, no fit-to-page.`
  doc.setFontSize(7.5)
  doc.setTextColor(120, 120, 120)
  doc.text(note, PAGE_W_MM / 2, ty + 1, { align: 'center' })

  doc.save(filename)
}

// ── Public API ────────────────────────────────────────────────────────────────

// innerCols / innerRows: number of INNER corners (OpenCV convention).
// The printed board has (innerCols+1) × (innerRows+1) squares.
export async function downloadCheckerboard(innerCols, innerRows, squareMm) {
  const sc = innerCols + 1, sr = innerRows + 1
  const canvas = renderCheckerboard(sc, sr, squareMm)
  await savePDF({
    canvas,
    boardWidthMm:  sc * squareMm,
    boardHeightMm: sr * squareMm,
    squareMm,
    title: `Checkerboard  ${sc} × ${sr} squares`,
    infoLines: [
      `Inner corners: ${innerCols} × ${innerRows}  •  Square: ${squareMm} mm`,
      `Board: ${sc * squareMm} × ${sr * squareMm} mm`,
    ],
    filename: `checkerboard_${sc}x${sr}_${squareMm}mm.pdf`,
  })
}

// cols / rows: total number of SQUARES on the ChArUco board.
export async function downloadCharucoBoard(cols, rows, squareMm) {
  const canvas = renderCharucoBoard(cols, rows, squareMm)
  const markerMm = (squareMm * 0.75).toFixed(0)
  await savePDF({
    canvas,
    boardWidthMm:  cols * squareMm,
    boardHeightMm: rows * squareMm,
    squareMm,
    title: `ChArUco Board  ${cols} × ${rows} squares  —  DICT_4X4_50`,
    infoLines: [
      `Square: ${squareMm} mm  •  Marker: ${markerMm} mm  •  Dictionary: ARUCO_DICT_4X4_50`,
      `Inner corners: ${cols - 1} × ${rows - 1}  •  Board: ${cols * squareMm} × ${rows * squareMm} mm`,
    ],
    filename: `charuco_${cols}x${rows}_${squareMm}mm.pdf`,
  })
}
