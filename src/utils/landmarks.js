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

export function getGroups(model) {
  return model === 'hands' ? HAND_GROUPS : POSE_GROUPS
}

export function getLandmarkNames(model) {
  return model === 'hands' ? HAND_LANDMARK_NAMES : POSE_LANDMARK_NAMES
}

export function getLandmarkName(model, index) {
  const names = getLandmarkNames(model)
  return names[index] ?? `landmark_${index}`
}
