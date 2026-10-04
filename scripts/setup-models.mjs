import { mkdir, copyFile, access, writeFile } from "node:fs/promises";
import { join } from "node:path";
const target = "public/models";
await mkdir(join(target, "wasm"), { recursive: true });
for (const name of [
  "vision_wasm_internal.js",
  "vision_wasm_internal.wasm",
  "vision_wasm_nosimd_internal.js",
  "vision_wasm_nosimd_internal.wasm",
]) {
  await copyFile(
    join("node_modules/@mediapipe/tasks-vision/wasm", name),
    join(target, "wasm", name),
  );
}
const path = join(target, "blaze_face_short_range.tflite");
try {
  await access(path);
} catch {
  const url =
    "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`Model download failed: ${response.status}`);
  await writeFile(path, Buffer.from(await response.arrayBuffer()));
}
console.log(
  "Face detector and WASM copied locally. Video frames are processed in the reviewer browser.",
);
