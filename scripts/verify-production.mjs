import { spawn } from "node:child_process";
import { get } from "node:https";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, sep, basename } from "node:path";
import { chromium } from "@playwright/test";

// Exercise compiled assets and the production CSP with a synthetic camera.
const temporaryRoot = resolve(tmpdir());
const directory = await mkdtemp(
  join(temporaryRoot, "clearview-production-check-"),
);
const reservation = createServer();
await new Promise((done) => reservation.listen(0, "127.0.0.1", done));
const port = reservation.address().port;
await new Promise((done) => reservation.close(done));
const base = `https://localhost:${port}`;
const password = randomBytes(32).toString("base64url");
const child = spawn(process.execPath, ["build/server/index.js"], {
  windowsHide: true,
  stdio: ["ignore", "ignore", "pipe"],
  env: {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(port),
    PUBLIC_BASE_URL: base,
    DATA_DIR: directory,
    ADMIN_PASSWORD: password,
    TLS_CERT_PATH: resolve(".data/dev-cert.pem"),
    TLS_KEY_PATH: resolve(".data/dev-key.pem"),
  },
});
let serverErrors = "";
child.stderr.on("data", (chunk) => {
  serverErrors += chunk.toString();
});
let browser;
try {
  const deadline = Date.now() + 20_000;
  while (true) {
    if (child.exitCode !== null)
      throw new Error(`Production server exited. ${serverErrors}`);
    const ready = await new Promise((done) => {
      const req = get(
        `${base}/api/health`,
        { rejectUnauthorized: false },
        (response) => {
          response.resume();
          done(response.statusCode === 200);
        },
      );
      req.on("error", () => done(false));
      req.setTimeout(1000, () => {
        req.destroy();
        done(false);
      });
    });
    if (ready) break;
    if (Date.now() > deadline)
      throw new Error("Production server did not become ready.");
    await new Promise((done) => setTimeout(done, 200));
  }
  browser = await chromium.launch({
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ],
  });
  const reviewerContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const participantContext = await browser.newContext({
    ignoreHTTPSErrors: true,
    permissions: ["camera"],
  });
  const login = await reviewerContext.request.post(`${base}/api/auth/login`, {
    data: { password },
  });
  if (!login.ok())
    throw new Error("Production reviewer authentication failed.");
  const created = await reviewerContext.request.post(`${base}/api/sessions`, {
    data: {
      candidateName: "Production Check",
      roleTitle: "Compiled asset verification",
      policy: {
        aiAllowed: false,
        extraDisplaysAllowed: false,
        phoneRequired: false,
        recordingEnabled: false,
        retentionDays: 1,
      },
    },
  });
  if (!created.ok()) throw new Error("Production interview creation failed.");
  const { session, links } = await created.json();
  const reviewer = await reviewerContext.newPage();
  const violations = [];
  reviewer.on("pageerror", (error) => violations.push(error.message));
  reviewer.on("console", (message) => {
    if (
      /violates the following Content Security Policy|Refused to.*policy/i.test(
        message.text(),
      )
    )
      violations.push(message.text());
  });
  await reviewer.goto(`${base}/sessions/${session.id}`);
  const candidate = await participantContext.newPage();
  await candidate.goto(links.candidateUrl);
  await candidate.getByRole("checkbox").check();
  await candidate
    .getByRole("button", { name: "Join monitoring session" })
    .click();
  await reviewer
    .getByText("Face-count checks active", { exact: true })
    .waitFor({ timeout: 20000 });
  const details = await (
    await reviewerContext.request.get(`${base}/api/sessions/${session.id}`)
  ).json();
  if (details.events.some((event) => event.kind === "vision_unavailable"))
    throw new Error(
      "Production face detector reported an initialization failure.",
    );
  if (violations.length)
    throw new Error(`Production browser errors: ${violations.join("; ")}`);
  await reviewerContext.request.delete(`${base}/api/sessions/${session.id}`);
  console.log(
    "Production check passed: compiled UI, HTTPS authentication, WebRTC camera, local WASM/model, and content security policy.",
  );
} finally {
  await browser?.close();
  if (child.exitCode === null) {
    const exited = new Promise((done) => child.once("exit", done));
    child.kill("SIGTERM");
    await exited;
  }
  if (
    !directory.startsWith(temporaryRoot + sep) ||
    !basename(directory).startsWith("clearview-production-check-")
  )
    throw new Error("Production test cleanup path rejected.");
  await rm(directory, { recursive: true, force: true });
}
