// ── Pose landmark definitions (MediaPipe 33-point model) ─────

export const POSE_LANDMARK_NAMES = [
  'nose','left_eye_inner','left_eye','left_eye_outer',
  'right_eye_inner','right_eye','right_eye_outer',
  'left_ear','right_ear',
  'mouth_left','mouth_right',
  'left_shoulder','right_shoulder',
  'left_elbow','right_elbow',
  'left_wrist','right_wrist',
  'left_pinky','right_pinky',
  'left_index','right_index',
  'left_thumb','right_thumb',
  'left_hip','right_hip',
  'left_knee','right_knee',
  'left_ankle','right_ankle',
  'left_heel','right_heel',
  'left_foot_index','right_foot_index'
]

export const POSE_GROUPS = {
  'Full Body':    { indices: Array.from({length:33},(_,i)=>i), color: '#5b7fff' },
  'Upper Body':   { indices: [11,12,13,14,15,16,17,18,19,20,21,22,23,24], color: '#7c5bff' },
  'Right Arm':    { indices: [12,14,16,18,20,22], color: '#3ecf70' },
  'Left Arm':     { indices: [11,13,15,17,19,21], color: '#f59e0b' },
  'Right Hand':   { indices: [16,18,20,22], color: '#3ecf70' },
  'Left Hand':    { indices: [15,17,19,21], color: '#f59e0b' },
  'Shoulders':    { indices: [11,12], color: '#ef4444' },
  'Lower Body':   { indices: [23,24,25,26,27,28,29,30,31,32], color: '#06b6d4' },
  'Right Leg':    { indices: [24,26,28,30,32], color: '#06b6d4' },
  'Left Leg':     { indices: [23,25,27,29,31], color: '#8b5cf6' },
}

// ── Hand landmark definitions (MediaPipe 21-point model) ──────

export const HAND_LANDMARK_NAMES = [
  'wrist',
  'thumb_cmc','thumb_mcp','thumb_ip','thumb_tip',
  'index_finger_mcp','index_finger_pip','index_finger_dip','index_finger_tip',
  'middle_finger_mcp','middle_finger_pip','middle_finger_dip','middle_finger_tip',
  'ring_finger_mcp','ring_finger_pip','ring_finger_dip','ring_finger_tip',
  'pinky_mcp','pinky_pip','pinky_dip','pinky_tip'
]

export const HAND_GROUPS = {
  'Full Hand':  { indices: Array.from({length:21},(_,i)=>i), color: '#5b7fff' },
  'Thumb':      { indices: [0,1,2,3,4], color: '#ef4444' },
  'Index':      { indices: [0,5,6,7,8], color: '#3ecf70' },
  'Middle':     { indices: [0,9,10,11,12], color: '#f59e0b' },
  'Ring':       { indices: [0,13,14,15,16], color: '#8b5cf6' },
  'Pinky':      { indices: [0,17,18,19,20], color: '#06b6d4' },
  'MCP Joints': { indices: [1,5,9,13,17], color: '#7c5bff' },
  'Fingertips': { indices: [4,8,12,16,20], color: '#f43f5e' },
  'Wrist':      { indices: [0], color: '#64748b' },
}

// ── Face landmark definitions (MediaPipe 478-point model) ─────
// Key anatomical landmarks named; rest use generic face_N label.

export const FACE_LANDMARK_NAMES = (() => {
  const n = Array.from({ length: 478 }, (_, i) => `face_${i}`)
  n[1]   = 'nose_bridge'
  n[4]   = 'nose_tip'
  n[9]   = 'forehead_left'
  n[10]  = 'forehead_center'
  n[17]  = 'lower_lip_bottom'
  n[33]  = 'right_eye_outer'
  n[61]  = 'right_mouth_corner'
  n[78]  = 'upper_lip_right'
  n[95]  = 'lower_lip_right'
  n[133] = 'right_eye_inner'
  n[152] = 'chin'
  n[168] = 'nose_bridge_top'
  n[234] = 'right_cheek'
  n[263] = 'left_eye_inner'
  n[291] = 'left_mouth_corner'
  n[308] = 'upper_lip_left'
  n[325] = 'lower_lip_left'
  n[362] = 'left_eye_outer'
  n[454] = 'left_cheek'
  n[468] = 'left_iris_center'
  n[469] = 'left_iris_outer'
  n[470] = 'left_iris_top'
  n[471] = 'left_iris_inner'
  n[472] = 'left_iris_bottom'
  n[473] = 'right_iris_center'
  n[474] = 'right_iris_outer'
  n[475] = 'right_iris_top'
  n[476] = 'right_iris_inner'
  n[477] = 'right_iris_bottom'
  return n
})()

// Groups use canonical MediaPipe face mesh indices for each region.
// "Left"/"Right" follow MediaPipe convention (subject's perspective).
export const FACE_GROUPS = {
  'Face Outline': {
    indices: [10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109],
    color: '#5b7fff',
  },
  'Left Eye': {
    indices: [362,382,381,380,374,373,390,249,263,466,388,387,386,385,384,398],
    color: '#3ecf70',
  },
  'Right Eye': {
    indices: [33,7,163,144,145,153,154,155,133,173,157,158,159,160,161,246],
    color: '#f59e0b',
  },
  'Left Eyebrow': {
    indices: [276,283,282,295,285,300,293,334,296,336],
    color: '#3ecf70',
  },
  'Right Eyebrow': {
    indices: [46,53,52,65,55,70,63,105,66,107],
    color: '#f59e0b',
  },
  'Lips': {
    indices: [61,146,91,181,84,17,314,405,321,375,291,308,324,318,402,317,14,87,178,88,95,78,191,80,81,82],
    color: '#ef4444',
  },
  'Nose': {
    indices: [1,2,4,5,6,19,94,97,98,164,168,195,197,326,327],
    color: '#8b5cf6',
  },
  'Left Iris': {
    indices: [468,469,470,471,472],
    color: '#06b6d4',
  },
  'Right Iris': {
    indices: [473,474,475,476,477],
    color: '#f43f5e',
  },
}

export function getGroups(model) {
  if (model === 'hands') return HAND_GROUPS
  if (model === 'face')  return FACE_GROUPS
  return POSE_GROUPS
}

export function getLandmarkNames(model) {
  if (model === 'hands') return HAND_LANDMARK_NAMES
  if (model === 'face')  return FACE_LANDMARK_NAMES
  return POSE_LANDMARK_NAMES
}

export function getLandmarkName(model, index) {
  const names = getLandmarkNames(model)
  return names[index] ?? `landmark_${index}`
}
