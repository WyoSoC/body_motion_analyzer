#!/usr/bin/env python3
"""Extract MediaPipe Pose world landmarks from the FMS reference segments.

Reads public/reference/fms_reference.json for the segment list, runs the
PoseLandmarker task (VIDEO mode) on each mp4 at a reduced sample rate, and
writes one JSON per segment to public/reference/landmarks/.

Output format (consumed by src/utils/fms_dtw.js):
  {
    "segment": "<id>",
    "model":   "pose_landmarker_heavy",
    "sampleFps": 15,
    "frames": [ { "t": <ms>, "wlm": [[x, y, z, visibility] x 33] }, ... ]
  }

World landmarks are meters, body-centered at the mid-hip (y increases
downward). Coordinates rounded to 4 decimals to keep files small.

Usage:
  python extract_reference_landmarks.py --model /path/to/pose_landmarker_heavy.task

Requires: pip install mediapipe (Python <= 3.13 as of mediapipe 0.10.x)
"""

import argparse
import json
import sys
from pathlib import Path

import cv2
import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision

REPO = Path(__file__).resolve().parent.parent
REF_DIR = REPO / "public" / "reference"
OUT_DIR = REF_DIR / "landmarks"

SAMPLE_FPS = 15


def extract(video_path: Path, model_path: Path) -> list[dict]:
    options = vision.PoseLandmarkerOptions(
        base_options=mp_python.BaseOptions(model_asset_path=str(model_path)),
        running_mode=vision.RunningMode.VIDEO,
        num_poses=1,
        min_pose_detection_confidence=0.5,
        min_tracking_confidence=0.5,
    )
    landmarker = vision.PoseLandmarker.create_from_options(options)

    cap = cv2.VideoCapture(str(video_path))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    step = max(1, round(fps / SAMPLE_FPS))

    frames = []
    idx = 0
    while True:
        ok, bgr = cap.read()
        if not ok:
            break
        if idx % step == 0:
            ts_ms = int(idx / fps * 1000)
            rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
            image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
            result = landmarker.detect_for_video(image, ts_ms)
            if result.pose_world_landmarks:
                wlm = [
                    [round(p.x, 4), round(p.y, 4), round(p.z, 4), round(p.visibility, 3)]
                    for p in result.pose_world_landmarks[0]
                ]
                frames.append({"t": ts_ms, "wlm": wlm})
        idx += 1

    cap.release()
    landmarker.close()
    return frames


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True, help="path to pose_landmarker_*.task")
    args = ap.parse_args()

    manifest = json.loads((REF_DIR / "fms_reference.json").read_text())
    OUT_DIR.mkdir(exist_ok=True)

    for seg in manifest["segments"]:
        video = REF_DIR / seg["file"]
        if not video.exists():
            print(f"SKIP {seg['id']}: {video} not found", file=sys.stderr)
            continue
        frames = extract(video, Path(args.model))
        out = {
            "segment": seg["id"],
            "model": Path(args.model).stem,
            "sampleFps": SAMPLE_FPS,
            "frames": frames,
        }
        out_path = OUT_DIR / (Path(seg["file"]).stem + ".json")
        out_path.write_text(json.dumps(out, separators=(",", ":")))
        print(f"{seg['id']}: {len(frames)} frames -> {out_path.name} "
              f"({out_path.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
