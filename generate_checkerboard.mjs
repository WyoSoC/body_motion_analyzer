/**
 * Generates checkerboard-calibration.pdf  (US Letter, landscape)
 * 9 × 6 inner corners, 20 mm squares → 10 × 7 grid, 200 × 140 mm board
 * Minimum 0.5 inch (12.7 mm) margin on all sides.
 *
 * Run:  node generate_checkerboard.mjs
 */

import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'
import { writeFileSync } from 'fs'

// ── Unit helpers ──────────────────────────────────────────────
const PT_PER_MM = 72 / 25.4
const mm = (v) => v * PT_PER_MM

// ── Page: Letter landscape ────────────────────────────────────
const PAGE_W_MM = 279.4
const PAGE_H_MM = 215.9
const PAGE_W = mm(PAGE_W_MM)
const PAGE_H = mm(PAGE_H_MM)

// ── Hard margins: 0.5 inch = 12.7 mm ─────────────────────────
const MARGIN_MM  = 12.7
const MARGIN     = mm(MARGIN_MM)
const USABLE_W   = PAGE_W - 2 * MARGIN   // 254 mm usable width
const USABLE_H   = PAGE_H - 2 * MARGIN   // 190.5 mm usable height

// ── Checkerboard: 10 × 7 squares @ 20 mm = 200 × 140 mm ──────
const SQ_MM   = 20
const COLS    = 10
const ROWS    = 7
const SQ      = mm(SQ_MM)
const BOARD_W = SQ * COLS    // 200 mm
const BOARD_H = SQ * ROWS    // 140 mm

// ── Vertical layout inside usable area ───────────────────────
//   Header block : 8 mm
//   Gap           : 3 mm
//   Board         : 140 mm
//   Gap           : 3 mm
//   Footer block  : 16 mm
//   Total         : 170 mm  (fits in 190.5 mm with 10.25 mm to spare each side)
const HEADER_H_MM = 8
const FOOTER_H_MM = 16
const GAP_MM      = 3
const CONTENT_H_MM = HEADER_H_MM + GAP_MM + (BOARD_H / PT_PER_MM) + GAP_MM + FOOTER_H_MM

const vExtra   = (190.5 - CONTENT_H_MM) / 2        // extra mm added top & bottom
const hExtra   = (254 - (BOARD_W / PT_PER_MM)) / 2 // extra mm left & right

// Board origin in PDF points (0,0 = bottom-left of page)
const BX = MARGIN + mm(hExtra)
const BY = MARGIN + mm(vExtra + FOOTER_H_MM + GAP_MM)

// ── Build PDF ─────────────────────────────────────────────────
const pdfDoc = await PDFDocument.create()
pdfDoc.setTitle('Calibration Checkerboard – Motion Analyzer')

const page = pdfDoc.addPage([PAGE_W, PAGE_H])

const fontBold   = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
const fontNormal = await pdfDoc.embedFont(StandardFonts.Helvetica)
const fontMono   = await pdfDoc.embedFont(StandardFonts.Courier)

const BLACK = rgb(0, 0, 0)
const WHITE = rgb(1, 1, 1)
const GREY  = rgb(0.65, 0.65, 0.65)
const DARK  = rgb(0.15, 0.15, 0.15)
const MED   = rgb(0.35, 0.35, 0.35)

// ── Checkerboard squares ──────────────────────────────────────
for (let row = 0; row < ROWS; row++) {
  for (let col = 0; col < COLS; col++) {
    page.drawRectangle({
      x: BX + col * SQ,
      y: BY + row * SQ,
      width:  SQ,
      height: SQ,
      color: (col + row) % 2 === 0 ? BLACK : WHITE,
    })
  }
}

// Board outer border (thin grey so edge white squares are visible)
page.drawRectangle({
  x: BX, y: BY, width: BOARD_W, height: BOARD_H,
  borderColor: GREY, borderWidth: 0.6,
})

// ── Header ────────────────────────────────────────────────────
const titleY = BY + BOARD_H + mm(GAP_MM) + mm(HEADER_H_MM * 0.6)

const title = 'Motion Analyzer  --  Calibration Checkerboard'
page.drawText(title, {
  x: PAGE_W / 2 - fontBold.widthOfTextAtSize(title, 10) / 2,
  y: titleY + mm(2.2),
  size: 10, font: fontBold, color: BLACK,
})

const params = `Inner corners: 9 x 6    |    Square size: ${SQ_MM} mm    |    Grid: ${COLS} x ${ROWS} squares    |    Board: ${COLS * SQ_MM} x ${ROWS * SQ_MM} mm`
page.drawText(params, {
  x: PAGE_W / 2 - fontNormal.widthOfTextAtSize(params, 7) / 2,
  y: titleY - mm(1.8),
  size: 7, font: fontNormal, color: MED,
})

// ── Footer: instructions (left column) ───────────────────────
const footerTopY = BY - mm(GAP_MM)
const lineH = mm(3.1)

const instrLines = [
  { text: 'How to use  --  Motion Analyzer Tab 1 (Calibration):', bold: true, size: 6.5 },
  { text: '1. Print at exactly 100% scale -- do NOT use "fit to page."',     bold: false, size: 5.8 },
  { text: '2. Measure the scale bar (right): it must be exactly 20 mm.',     bold: false, size: 5.8 },
  { text: '3. Place board flat, square to the camera lens.',                  bold: false, size: 5.8 },
  { text: '4. App settings: Inner Cols = 9, Inner Rows = 6, Square = 20 mm.',bold: false, size: 5.8 },
  { text: '5. Click 2 points spanning N squares, enter N, click Calculate.',  bold: false, size: 5.8 },
]

instrLines.forEach(({ text, bold, size }, i) => {
  page.drawText(text, {
    x: BX,
    y: footerTopY - i * lineH,
    size,
    font:  bold ? fontBold : fontMono,
    color: bold ? DARK : MED,
  })
})

// ── Footer: scale bar (right-aligned to board edge) ───────────
const sbW  = mm(SQ_MM)           // same width as one square (20 mm)
const sbH  = mm(4)
const sbX  = BX + BOARD_W - sbW
const sbY  = footerTopY - mm(9)

// Half-black / half-white tile
page.drawRectangle({ x: sbX,           y: sbY, width: sbW / 2, height: sbH, color: BLACK })
page.drawRectangle({ x: sbX + sbW / 2, y: sbY, width: sbW / 2, height: sbH, color: WHITE })
page.drawRectangle({ x: sbX,           y: sbY, width: sbW,     height: sbH,
  borderColor: GREY, borderWidth: 0.5 })

// Tick marks + labels at 0, 10, 20 mm
const ticks = [[0, '0'], [sbW / 2, '10'], [sbW, '20 mm']]
ticks.forEach(([xOff, label]) => {
  const tx = sbX + xOff
  page.drawLine({
    start: { x: tx, y: sbY - mm(0.8) },
    end:   { x: tx, y: sbY },
    thickness: 0.5, color: DARK,
  })
  page.drawText(label, {
    x: tx - fontNormal.widthOfTextAtSize(label, 5) / 2,
    y: sbY - mm(3.8),
    size: 5, font: fontNormal, color: MED,
  })
})

// Label above scale bar
const lbl1 = 'Scale check:  |-- 20 mm --|'
const lbl2 = 'Measure before calibrating'
page.drawText(lbl1, {
  x: sbX + sbW / 2 - fontBold.widthOfTextAtSize(lbl1, 5.5) / 2,
  y: sbY + sbH + mm(1.5),
  size: 5.5, font: fontBold, color: DARK,
})
page.drawText(lbl2, {
  x: sbX + sbW / 2 - fontNormal.widthOfTextAtSize(lbl2, 5) / 2,
  y: sbY + sbH + mm(1.5) - mm(3),
  size: 5, font: fontNormal, color: MED,
})

// ── Save ──────────────────────────────────────────────────────
const pdfBytes = await pdfDoc.save()
const outFile  = 'checkerboard-calibration.pdf'
writeFileSync(outFile, pdfBytes)

const effMarginH = MARGIN_MM + hExtra
const effMarginV = MARGIN_MM + vExtra
console.log(`Saved: ${outFile}`)
console.log(`  Page:           ${PAGE_W_MM} x ${PAGE_H_MM} mm (Letter landscape)`)
console.log(`  Board:          ${COLS * SQ_MM} x ${ROWS * SQ_MM} mm  (${COLS}x${ROWS} squares @ ${SQ_MM} mm)`)
console.log(`  Inner corners:  ${COLS - 1} x ${ROWS - 1}`)
console.log(`  Left/right margin: ${effMarginH.toFixed(1)} mm  (min required: ${MARGIN_MM} mm)`)
console.log(`  Top/bottom margin: ${effMarginV.toFixed(1)} mm  (min required: ${MARGIN_MM} mm)`)
