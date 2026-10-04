import { FaceDetector, FilesetResolver } from "@mediapipe/tasks-vision";
// The detector runs on the reviewer's received laptop stream. No emotional or identity inference.
export async function watchFaces(
  stream: MediaStream,
  observation: (kind: string, detail: string, count: number) => void,
) {
  const vision = await FilesetResolver.forVisionTasks("/models/wasm");
  const detector = await FaceDetector.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: "/models/blaze_face_short_range.tflite",
      delegate: "CPU",
    },
    runningMode: "VIDEO",
    minDetectionConfidence: 0.75,
  });
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  await video.play();
  let previousCount = -1,
    since = performance.now(),
    lastAlert = -Infinity,
    lastFrame = -1;
  const timer = setInterval(() => {
    if (
      !video.videoWidth ||
      video.readyState < 2 ||
      video.currentTime === lastFrame
    )
      return;
    lastFrame = video.currentTime;
    const count = detector.detectForVideo(video, performance.now()).detections
      .length;
    const now = performance.now();
    if (count !== previousCount) {
      previousCount = count;
      since = now;
    }
    if (now - lastAlert < 30_000) return;
    if (count > 1 && now - since > 3000) {
      lastAlert = now;
      observation(
        "multiple_faces",
        `${count} faces detected in the laptop view for at least 3 seconds. Review the camera evidence.`,
        count,
      );
    }
    if (count === 0 && now - since > 10_000) {
      lastAlert = now;
      observation(
        "face_absent",
        "No face detected in the laptop view for at least 10 seconds. Check framing, lighting, and camera connectivity.",
        count,
      );
    }
  }, 500);
  return () => {
    clearInterval(timer);
    detector.close();
    video.pause();
    video.srcObject = null;
  };
}
