import {
  PoseLandmarker,
  HandLandmarker,
  FilesetResolver,
  DrawingUtils
} from '@mediapipe/tasks-vision'

// Absolute path — served from public/wasm/, version-matched to installed package.
const WASM_PATH = '/wasm'
const MODELS = {
  pose:  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task',
  hands: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task',
}

let _vision = null
let _poseLandmarker = null
let _handLandmarker = null

export async function initVision(onStatus) {
  onStatus?.('loading')
  _vision = await FilesetResolver.forVisionTasks(WASM_PATH)
  onStatus?.('ready')
  return _vision
}

export async function loadModel(model, onStatus) {
  if (!_vision) throw new Error('Vision not initialized')
  onStatus?.('loading-model')

  if (model === 'pose') {
    if (_poseLandmarker) return _poseLandmarker
    _poseLandmarker = await PoseLandmarker.createFromOptions(_vision, {
      baseOptions: { modelAssetPath: MODELS.pose, delegate: 'CPU' },
      runningMode: 'VIDEO',
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    })
    return _poseLandmarker
  }

  if (model === 'hands') {
    if (_handLandmarker) return _handLandmarker
    _handLandmarker = await HandLandmarker.createFromOptions(_vision, {
      baseOptions: { modelAssetPath: MODELS.hands, delegate: 'CPU' },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    })
    return _handLandmarker
  }

  throw new Error(`Unknown model: ${model}`)
}

export function detectFrame(landmarker, model, videoEl, timestampMs) {
  if (!landmarker || !videoEl || videoEl.readyState < 2) return null

  try {
    if (model === 'pose') {
      const result = landmarker.detectForVideo(videoEl, timestampMs)
      if (!result.landmarks?.length) return null
      return {
        landmarks: result.landmarks[0],
        worldLandmarks: result.worldLandmarks?.[0] ?? null,
      }
    }

    if (model === 'hands') {
      const result = landmarker.detectForVideo(videoEl, timestampMs)
      if (!result.landmarks?.length) return null
      // Return first hand detected (or both if 2 hands)
      return {
        landmarks: result.landmarks[0],
        worldLandmarks: result.worldLandmarks?.[0] ?? null,
        handedness: result.handednesses?.[0]?.[0]?.categoryName ?? null,
        allHands: result.landmarks.map((lms, i) => ({
          landmarks: lms,
          worldLandmarks: result.worldLandmarks?.[i] ?? null,
          handedness: result.handednesses?.[i]?.[0]?.categoryName ?? null,
        })),
      }
    }
  } catch (_) {
    return null
  }
  return null
}

// ── Drawing ───────────────────────────────────────────────────

const POSE_CONNECTIONS = PoseLandmarker.POSE_CONNECTIONS
const HAND_CONNECTIONS = HandLandmarker.HAND_CONNECTIONS

export function drawResults(ctx, result, model, canvasWidth, canvasHeight) {
  if (!result) return
  ctx.clearRect(0, 0, canvasWidth, canvasHeight)
  const drawingUtils = new DrawingUtils(ctx)

  if (model === 'pose') {
    drawingUtils.drawConnectors(result.landmarks, POSE_CONNECTIONS, {
      color: 'rgba(91,127,255,0.7)', lineWidth: 2
    })
    drawingUtils.drawLandmarks(result.landmarks, {
      color: '#5b7fff', fillColor: '#fff', radius: 3, lineWidth: 1
    })
    return
  }

  if (model === 'hands') {
    const hands = result.allHands ?? [result]
    const colors = ['#3ecf70', '#f59e0b']
    hands.forEach((hand, i) => {
      drawingUtils.drawConnectors(hand.landmarks, HAND_CONNECTIONS, {
        color: colors[i % 2] + 'aa', lineWidth: 2
      })
      drawingUtils.drawLandmarks(hand.landmarks, {
        color: colors[i % 2], fillColor: '#fff', radius: 4, lineWidth: 1
      })
    })
  }
}

// Draw stored landmark frame (for playback overlay)
export function drawStoredFrame(ctx, landmarkFrame, model, canvasWidth, canvasHeight) {
  if (!landmarkFrame?.landmarks) return
  drawResults(ctx, { landmarks: landmarkFrame.landmarks, allHands: landmarkFrame.allHands }, model, canvasWidth, canvasHeight)
}

// ── Camera enumeration ────────────────────────────────────────

export async function listCameras() {
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices.filter(d => d.kind === 'videoinput').map((d, i) => ({
    deviceId: d.deviceId,
    label: d.label || `Camera ${i + 1}`,
  }))
}

export async function openCamera(deviceId, videoEl) {
  if (videoEl.srcObject) {
    videoEl.srcObject.getTracks().forEach(t => t.stop())
  }
  const constraints = {
    video: {
      // Only use exact constraint when we have a real non-empty deviceId.
      // On first open, deviceId may be empty because enumerateDevices runs
      // before permission is granted — fall back to any camera.
      deviceId: deviceId ? { exact: deviceId } : undefined,
      width:     { ideal: 1280 },
      height:    { ideal: 720 },
      frameRate: { ideal: 30 },
    }
  }
  const stream = await navigator.mediaDevices.getUserMedia(constraints)
  videoEl.srcObject = stream
  await videoEl.play()
  return stream
}

// Re-enumerate after permission grant to get real labels + IDs
export async function listCamerasAfterPermission() {
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices.filter(d => d.kind === 'videoinput').map((d, i) => ({
    deviceId: d.deviceId,
    label:    d.label || `Camera ${i + 1}`,
  }))
}

export function stopCamera(videoEl) {
  videoEl?.srcObject?.getTracks().forEach(t => t.stop())
  if (videoEl) videoEl.srcObject = null
}

// Stop every active camera stream on the page (used on tab switch)
export function stopAllCameraStreams() {
  document.querySelectorAll('video').forEach(v => {
    v.srcObject?.getTracks().forEach(t => t.stop())
    v.srcObject = null
  })
}
