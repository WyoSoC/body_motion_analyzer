# Body Motion Analyzer

A fully browser-based body motion capture and analysis tool — no server, no install, no data leaves your device.

**Live app:** https://WyoSoC.github.io/body_motion_analyzer/

---

## Features

### Calibration
Set a pixel-to-millimeter scale factor for real-world measurements using either:
- **Ruler method** — click two points on the camera preview and enter the known distance
- **Checkerboard (auto)** — print `checkerboard-calibration.pdf`, hold it in front of the camera, and let OpenCV.js detect the corners automatically

### Collection
Record motion trials with live camera and MediaPipe AI landmark overlay:
- **Pose model** — 33 full-body landmarks (BlazePose)
- **Hands model** — 21 landmarks per hand
- Organize recordings into named sessions with optional calibration profile
- **Voice control** — say "Begin trial" / "End trial" hands-free (Chrome/Edge)
- Auto-stop after a configurable duration
- Export each trial as a landmark **CSV** and/or **WebM video**

### Analysis
Replay and analyze recorded trials:
- Video playback with synchronized landmark overlay
- Compute per-landmark or grouped metrics:
  - Speed, Acceleration, Jerk
  - Normalized Jerk (smoothness index)
  - Sample Entropy (signal complexity)
  - Range of Motion (X, Y, resultant)
- Summary statistics table
- **Multi-trial comparison** — bar chart of mean/peak speed across selected trials

All data is stored locally in your browser's IndexedDB — nothing is uploaded anywhere.

---

## Tech Stack

| Library | Purpose |
|---|---|
| [MediaPipe Tasks Vision](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker) | Pose & hand landmark detection (WASM, runs in-browser) |
| [Chart.js](https://www.chartjs.org/) | Time-series and bar charts |
| [idb](https://github.com/jakearchibald/idb) | IndexedDB wrapper for session/trial storage |
| [Vite](https://vitejs.dev/) | Build tool |
| [OpenCV.js](https://docs.opencv.org/4.8.0/d5/d10/tutorial_js_root.html) | Checkerboard corner detection (lazy-loaded, ~7 MB) |

---

## Local Development

```bash
# Install dependencies (also copies MediaPipe WASM files into public/wasm/)
npm install

# Start dev server at http://localhost:5173
npm run dev

# Production build → dist/
npm run build
```

---

## Calibration Checkerboard

The files `checkerboard-calibration.pdf` and `checkerboard-print.html` contain a printable 9×6 inner-corner checkerboard with 20 mm squares. Print at 100% scale (no fit-to-page), measure a few squares with a ruler to verify accuracy, then use the **Checkerboard (auto)** calibration method in the app.

---

## Deployment

This repo uses a GitHub Actions workflow (`.github/workflows/deploy.yml`) that automatically builds and deploys to GitHub Pages on every push to `main`. No manual steps required after setup.

---

## License

MIT © Jian Gong
