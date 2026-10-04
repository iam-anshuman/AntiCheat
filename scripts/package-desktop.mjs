import { spawn } from "node:child_process";
import { mkdtemp, mkdir, copyFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep, basename } from "node:path";

// Packaging in a fresh temporary directory avoids Windows/OneDrive rename locks
// on the previously unpacked Electron tree. Only the finished executable is copied back.
const temporaryRoot = resolve(tmpdir());
const buildDirectory = await mkdtemp(join(temporaryRoot, "clearview-package-"));
const cli = resolve("node_modules/electron-builder/cli.js");
const code = await new Promise((done, reject) => {
  const child = spawn(
    process.execPath,
    [cli, "--win", "portable", `--config.directories.output=${buildDirectory}`],
    { stdio: "inherit", windowsHide: true },
  );
  child.on("error", reject);
  child.on("exit", done);
});
if (code !== 0) {
  console.error(`Packaging failed. Build files preserved at ${buildDirectory}`);
  process.exit(code || 1);
}
await mkdir("release", { recursive: true });
const filename = "Clearview-Candidate-0.1.0.exe";
const destination = resolve("release", filename);
await copyFile(join(buildDirectory, filename), destination);
console.log(
  `Candidate executable ready: ${destination} (${Math.round((await stat(destination)).size / 1024 / 1024)} MB)`,
);
if (
  !buildDirectory.startsWith(temporaryRoot + sep) ||
  !basename(buildDirectory).startsWith("clearview-package-")
)
  throw new Error("Temporary packaging cleanup path rejected.");
await rm(buildDirectory, { recursive: true, force: true });
