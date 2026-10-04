export const participantEvents = {
  camera_started: ["info", "Camera connected"],
  camera_stopped: ["technical", "Camera stopped"],
  camera_muted: ["technical", "Camera feed interrupted"],
  screen_started: ["info", "Screen sharing started"],
  screen_stopped: ["technical", "Screen sharing stopped"],
  capture_failed: ["technical", "Capture permission or device issue"],
  desktop_unavailable: ["technical", "Desktop telemetry unavailable"],
} as const;
export const reviewerEvents = {
  multiple_faces: ["review", "Multiple faces visible"],
  face_absent: ["technical", "Face not detected in laptop view"],
  vision_unavailable: ["technical", "Face detection unavailable"],
  recording_failed: ["technical", "Recording interrupted"],
  peer_failed: ["technical", "Video connection interrupted"],
  bookmark: ["review", "Interviewer bookmark"],
} as const;
