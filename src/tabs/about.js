// About / landing tab — brief background on the app and a Launch button that
// jumps the user straight into Data Collection (Tab #2).

export function initAbout(container, { onLaunch } = {}) {
  container.innerHTML = buildUI()
  container.querySelector('#about-launch')?.addEventListener('click', () => onLaunch?.())
}

function buildUI() {
  return `
<div style="max-width:820px;margin:0 auto">

  <div class="card" style="text-align:center;padding:32px 28px">
    <div style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;
      color:var(--accent);font-weight:700;margin-bottom:10px">Welcome</div>
    <h2 style="font-size:26px;line-height:1.25;margin:0 0 12px;font-weight:700">
      Kinesiology Markerless Motion Capture &amp; Analysis
    </h2>
    <p style="font-size:14px;line-height:1.75;color:var(--text-muted);max-width:640px;margin:0 auto">
      Capture and analyze human movement using nothing but a webcam — no suits,
      no physical markers. The app runs Google MediaPipe pose estimation in your
      browser to track 33 body landmarks in 3-D, records movement trials, and
      grades Functional Movement Screen (FMS) tests against a gold-standard
      reference performance. All processing happens locally on your machine.
    </p>
  </div>

  <div class="card">
    <div class="card-title">How it works</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:14px;margin-top:6px">

      <div style="padding:14px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg)">
        <div style="font-size:11px;font-weight:700;color:var(--accent);margin-bottom:5px">STEP 1 · OPTIONAL</div>
        <div style="font-size:13px;font-weight:600;margin-bottom:4px">Calibration</div>
        <div style="font-size:11.5px;color:var(--text-muted);line-height:1.6">
          Print a checkerboard to set a real-world pixel scale for metric
          measurements. Skip it for markerless pose analysis.
        </div>
      </div>

      <div style="padding:14px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg)">
        <div style="font-size:11px;font-weight:700;color:var(--accent);margin-bottom:5px">STEP 2</div>
        <div style="font-size:13px;font-weight:600;margin-bottom:4px">Data Collection</div>
        <div style="font-size:11.5px;color:var(--text-muted);line-height:1.6">
          Record movement trials with live skeleton tracking and hands-free
          voice control to start and stop each take.
        </div>
      </div>

      <div style="padding:14px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg)">
        <div style="font-size:11px;font-weight:700;color:var(--accent);margin-bottom:5px">STEP 3</div>
        <div style="font-size:13px;font-weight:600;margin-bottom:4px">Raw Marker Analysis</div>
        <div style="font-size:11.5px;color:var(--text-muted);line-height:1.6">
          Inspect joint angles and velocities over time, review per-landmark
          kinematics, and export the data as CSV.
        </div>
      </div>

      <div style="padding:14px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg)">
        <div style="font-size:11px;font-weight:700;color:var(--accent);margin-bottom:5px">STEP 4</div>
        <div style="font-size:13px;font-weight:600;margin-bottom:4px">FMS Analysis</div>
        <div style="font-size:11.5px;color:var(--text-muted);line-height:1.6">
          Score movements against the reference — DTW form similarity, left/right
          symmetry, and vertical alignment — for a combined FMS score.
        </div>
      </div>

    </div>
  </div>

  <div style="text-align:center;margin:26px 0 8px">
    <button id="about-launch" class="btn btn-primary btn-lg"
      style="font-size:17px;padding:15px 46px;border-radius:var(--radius-lg);
      background:linear-gradient(135deg,var(--accent),var(--accent2));
      box-shadow:0 6px 20px rgba(91,127,255,.35)">
      Launch  →
    </button>
    <div style="font-size:11.5px;color:var(--text-muted);margin-top:12px">
      Takes you to <strong style="color:var(--text)">Step 2 · Data Collection</strong>.
      Calibration is optional — start recording right away.
    </div>
  </div>

</div>`
}
