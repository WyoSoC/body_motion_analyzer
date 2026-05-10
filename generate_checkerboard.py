"""
Generate checkerboard-calibration.pdf  (US Letter, landscape)
9 × 6 inner corners, 25 mm squares  →  10 × 7 grid of squares, 250 × 175 mm board
Run: python generate_checkerboard.py
"""

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.patches import Rectangle
import numpy as np

# ── Page dimensions ───────────────────────────────────────────
PAGE_W_MM = 279.4   # letter landscape
PAGE_H_MM = 215.9

# ── Checkerboard parameters ───────────────────────────────────
SQUARE_MM   = 25
COLS        = 10    # squares per row
ROWS        = 7     # squares per column
BOARD_W     = SQUARE_MM * COLS   # 250 mm
BOARD_H     = SQUARE_MM * ROWS   # 175 mm

# ── Layout (all in mm from bottom-left) ──────────────────────
HEADER_H    = 9    # mm for header text
FOOTER_H    = 14   # mm for footer text
VGAP        = 3    # gap between text and board

total_content = HEADER_H + VGAP + BOARD_H + VGAP + FOOTER_H  # 204 mm
top_margin   = (PAGE_H_MM - total_content) / 2          # ~6 mm
left_margin  = (PAGE_W_MM - BOARD_W) / 2                # ~14.7 mm

# board origin in mm from bottom-left
board_x = left_margin
board_y = top_margin + FOOTER_H + VGAP

# ── Figure ────────────────────────────────────────────────────
fig_w = PAGE_W_MM / 25.4   # inches
fig_h = PAGE_H_MM / 25.4
fig, ax = plt.subplots(figsize=(fig_w, fig_h))
fig.patch.set_facecolor('white')

ax.set_xlim(0, PAGE_W_MM)
ax.set_ylim(0, PAGE_H_MM)
ax.set_aspect('equal')
ax.axis('off')

# Use mm coordinates throughout
def mm_rect(x, y, w, h, color):
    ax.add_patch(Rectangle((x, y), w, h, facecolor=color, edgecolor='none'))

# ── Draw squares ──────────────────────────────────────────────
for row in range(ROWS):
    for col in range(COLS):
        color = 'black' if (col + row) % 2 == 0 else 'white'
        mm_rect(board_x + col * SQUARE_MM,
                board_y + row * SQUARE_MM,
                SQUARE_MM, SQUARE_MM, color)

# ── Board border (thin grey outline) ─────────────────────────
ax.add_patch(Rectangle((board_x, board_y), BOARD_W, BOARD_H,
                        fill=False, edgecolor='#999999', linewidth=0.5))

# ── Header text ───────────────────────────────────────────────
header_y = board_y + BOARD_H + VGAP + HEADER_H * 0.35
ax.text(PAGE_W_MM / 2, header_y,
        'Motion Analyzer – Calibration Checkerboard',
        ha='center', va='center',
        fontsize=9, fontweight='bold', color='black')
ax.text(PAGE_W_MM / 2, header_y - 3.8,
        'Inner corners: 9 × 6    |    Square size: 25 mm    |    Grid: 10 × 7 squares    |    Board: 250 × 175 mm',
        ha='center', va='center',
        fontsize=6.5, color='#444444')

# ── Footer – instructions (left) ─────────────────────────────
instr_x = board_x
instr_y  = top_margin + FOOTER_H * 0.85

instructions = (
    'How to use in Motion Analyzer → Tab 1 (Calibration):\n'
    '1. Print at 100% scale – do not "fit to page".\n'
    '2. Verify the scale bar (right) measures exactly 25 mm with a ruler.\n'
    '3. Place board flat, perpendicular to the camera.\n'
    '4. In the app: Inner Cols = 9, Inner Rows = 6, Square Size = 25 mm.\n'
    '5. Click 2 points spanning a known number of squares, enter count, click Calculate.'
)
ax.text(instr_x, instr_y, instructions,
        ha='left', va='top',
        fontsize=5.8, color='#333333',
        linespacing=1.55,
        fontfamily='monospace')

# ── Footer – scale bar (right) ────────────────────────────────
sb_right = board_x + BOARD_W
sb_y     = top_margin + FOOTER_H * 0.55

# White half + black half = 25 mm total  (a mini 1-square reference)
half = SQUARE_MM / 2
mm_rect(sb_right - SQUARE_MM, sb_y, half, 3.5, 'black')
mm_rect(sb_right - half,      sb_y, half, 3.5, 'white')
ax.add_patch(Rectangle((sb_right - SQUARE_MM, sb_y), SQUARE_MM, 3.5,
                        fill=False, edgecolor='#666', linewidth=0.5))

# Tick marks at 0, 12.5, 25 mm
for x_off, label in [(0, '0'), (half, '12.5'), (SQUARE_MM, '25')]:
    xpos = sb_right - SQUARE_MM + x_off
    ax.plot([xpos, xpos], [sb_y - 1, sb_y], color='#333', linewidth=0.6)
    ax.text(xpos, sb_y - 1.8, label,
            ha='center', va='top', fontsize=5, color='#333')

ax.text(sb_right - SQUARE_MM / 2, sb_y + 5.2,
        'Scale: ← 25 mm →\n(verify with ruler before calibrating)',
        ha='center', va='bottom', fontsize=5.5, color='#444',
        linespacing=1.4)

# ── Save ──────────────────────────────────────────────────────
out = 'checkerboard-calibration.pdf'
fig.savefig(out, format='pdf', dpi=300,
            bbox_inches=None,
            facecolor='white',
            metadata={'Title': 'Calibration Checkerboard – Motion Analyzer'})
plt.close(fig)
print(f'Saved: {out}')
print(f'  Page:  {PAGE_W_MM} × {PAGE_H_MM} mm  (Letter landscape)')
print(f'  Board: {BOARD_W} × {BOARD_H} mm  ({COLS}×{ROWS} squares @ {SQUARE_MM} mm)')
print(f'  Inner corners: {COLS-1} × {ROWS-1}')
