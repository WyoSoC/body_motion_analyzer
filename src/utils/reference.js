// FMS reference video manifest — gold-standard demonstration segments.
//
// The manifest (public/reference/fms_reference.json) describes the source
// YouTube video and its per-movement segments. The segment mp4 files live in
// public/reference/segments/ and are served statically; they are NOT in git,
// so all consumers must handle a missing manifest or missing files gracefully.

const BASE = 'reference/'

let _manifestPromise = null

// Fetch the manifest once and cache it. Resolves to null when unavailable
// (e.g., segments not downloaded on this machine).
export function loadReferenceManifest() {
  if (!_manifestPromise) {
    _manifestPromise = fetch(BASE + 'fms_reference.json')
      .then(res => res.ok ? res.json() : null)
      .catch(() => null)
  }
  return _manifestPromise
}

export function segmentUrl(segment) {
  return BASE + segment.file
}

// Find a segment by its id (matches the app's test ids, e.g. 'deep-squat').
export function findSegment(manifest, id) {
  return manifest?.segments?.find(s => s.id === id) ?? null
}

// ── Reference landmark templates ──────────────────────────────
// Extracted offline by scripts/extract_reference_landmarks.py.
// Format: { segment, model, sampleFps, frames: [{t, wlm: [[x,y,z,vis] x33]}] }

const _landmarkCache = new Map()

// Resolves to null when the segment has no landmark file (not yet extracted).
export async function loadReferenceLandmarks(manifest, id) {
  const seg = findSegment(manifest, id)
  if (!seg?.landmarks) return null
  if (!_landmarkCache.has(seg.id)) {
    _landmarkCache.set(seg.id,
      fetch(BASE + seg.landmarks)
        .then(res => res.ok ? res.json() : null)
        .catch(() => null))
  }
  return _landmarkCache.get(seg.id)
}
