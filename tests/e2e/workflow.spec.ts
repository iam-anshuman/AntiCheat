import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

test("reviewer creates an interview, reviews evidence and ends the session", async ({
  page,
}) => {
  const password =
    process.env.ADMIN_PASSWORD ||
    readFileSync(".data/admin-password", "utf8").trim();
  await page.goto("/");
  await page.getByLabel("Reviewer password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Open workspace" }).click();
  await expect(
    page.getByRole("heading", { name: "Overview", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/overview.png", fullPage: true });
  await page.getByRole("button", { name: "New interview" }).click();
  await page.getByLabel("Candidate name").fill("Browser Test Candidate");
  await page.getByLabel("Interview role").fill("Frontend engineer");
  await page
    .getByRole("button", { name: "Create interview", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const candidateUrl = await page
    .getByLabel("Candidate invite URL")
    .inputValue();
  const phoneUrl = await page.getByLabel("Phone invite URL").inputValue();
  expect(candidateUrl).toContain("/join/");
  expect(phoneUrl).toContain("/phone/");
  await page.getByRole("button", { name: "Close dialog" }).click();
  await expect(
    page.getByRole("heading", { name: "Browser Test Candidate" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Add a bookmark" }).click();
  await page
    .getByLabel("What did you observe?")
    .fill("Candidate explained their approach.");
  await page.getByRole("button", { name: "Save bookmark" }).click();
  await page.getByRole("button", { name: /Interviewer bookmark/ }).click();
  await page.getByLabel("Review status").selectOption("dismissed");
  await page
    .getByLabel("Reviewer note")
    .fill("Permitted discussion; no concern.");
  await page.getByRole("button", { name: "Save review" }).click();
  await expect(
    page.getByRole("button", { name: /Interviewer bookmark/ }),
  ).toContainText("Dismissed");
  await page.screenshot({ path: "test-results/session.png", fullPage: true });
  await page
    .getByRole("button", { name: "End interview", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "End interview", exact: true })
    .click();
  await expect(page.locator(".session-title")).toContainText("Completed");
  const sessionId = page.url().split("/").at(-1)!;
  await page.request.delete(`/api/sessions/${sessionId}`);
});

test("mobile invite shows session rules and requires consent", async ({
  browser,
  request,
}) => {
  const password =
    process.env.ADMIN_PASSWORD ||
    readFileSync(".data/admin-password", "utf8").trim();
  await request.post("/api/auth/login", { data: { password } });
  const created = await request.post("/api/sessions", {
    data: {
      candidateName: "Mobile Test",
      roleTitle: "Technical interview",
      policy: {
        aiAllowed: false,
        extraDisplaysAllowed: false,
        phoneRequired: true,
        recordingEnabled: false,
        retentionDays: 1,
      },
    },
  });
  const { session, links } = await created.json();
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
  });
  const phone = await context.newPage();
  await phone.goto(
    links.phoneUrl.replace(
      new URL(links.phoneUrl).origin,
      "https://localhost:3443",
    ),
  );
  await expect(
    phone.getByRole("heading", { name: "Set up your desk camera" }),
  ).toBeVisible();
  await expect(
    phone.getByRole("button", { name: "Connect desk camera" }),
  ).toBeDisabled();
  await phone.getByRole("checkbox").check();
  await expect(
    phone.getByRole("button", { name: "Connect desk camera" }),
  ).toBeEnabled();
  await phone.screenshot({ path: "test-results/phone.png", fullPage: true });
  await context.close();
  await request.delete(`/api/sessions/${session.id}`);
});

test("two synthetic cameras and a screen reach the reviewer and produce playable recordings", async ({
  browser,
}) => {
  const reviewerContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const laptopContext = await browser.newContext({
    ignoreHTTPSErrors: true,
    permissions: ["camera"],
  });
  const phoneContext = await browser.newContext({
    ignoreHTTPSErrors: true,
    permissions: ["camera"],
    viewport: { width: 390, height: 844 },
  });
  let sessionId: string | undefined;
  try {
    const password =
      process.env.ADMIN_PASSWORD ||
      readFileSync(".data/admin-password", "utf8").trim();
    await reviewerContext.request.post(
      "https://localhost:3443/api/auth/login",
      { data: { password } },
    );
    const created = await reviewerContext.request.post(
      "https://localhost:3443/api/sessions",
      {
        data: {
          candidateName: "Synthetic Media Test",
          roleTitle: "Streaming validation",
          policy: {
            aiAllowed: false,
            extraDisplaysAllowed: false,
            phoneRequired: true,
            recordingEnabled: true,
            retentionDays: 1,
          },
        },
      },
    );
    const { session, links } = await created.json();
    sessionId = session.id;
    const reviewer = await reviewerContext.newPage();
    const browserErrors: string[] = [];
    reviewer.on("pageerror", (e) => browserErrors.push(e.message));
    await reviewer.goto(`https://localhost:3443/sessions/${session.id}`);
    await expect(
      reviewer.getByRole("heading", { name: "Synthetic Media Test" }),
    ).toBeVisible();
    const laptop = await laptopContext.newPage();
    await laptop.addInitScript(() => {
      navigator.mediaDevices.getDisplayMedia = async () => {
        const canvas = document.createElement("canvas");
        canvas.width = 960;
        canvas.height = 540;
        const context = canvas.getContext("2d")!;
        const draw = () => {
          context.fillStyle = "#142335";
          context.fillRect(0, 0, 960, 540);
          context.fillStyle = "#b3e9d2";
          context.font = "32px sans-serif";
          context.fillText("SYNTHETIC SCREEN · STREAMING TEST", 70, 260);
          context.font = "18px sans-serif";
          context.fillText(new Date().toISOString(), 70, 310);
        };
        draw();
        const timer = setInterval(draw, 125);
        const stream = canvas.captureStream(8),
          track = stream.getVideoTracks()[0],
          getSettings = track.getSettings.bind(track),
          stop = track.stop.bind(track);
        track.getSettings = () => ({
          ...getSettings(),
          displaySurface: "monitor",
        });
        track.stop = () => {
          clearInterval(timer);
          stop();
        };
        return stream;
      };
    });
    const local = (url: string) =>
      url.replace(new URL(url).origin, "https://localhost:3443");
    await laptop.goto(local(links.candidateUrl));
    await laptop.getByRole("checkbox").check();
    await laptop
      .getByRole("button", { name: "Join monitoring session" })
      .click();
    await expect(
      laptop.getByRole("heading", { name: "You’re connected" }),
    ).toBeVisible();
    await expect
      .poll(() => reviewer.locator(".camera-grid video").count())
      .toBe(1);
    await laptop.getByRole("button", { name: "Share entire screen" }).click();
    await expect
      .poll(() =>
        reviewer
          .locator(".screen-feed video")
          .evaluateAll((videos) =>
            videos.some((v) => (v as HTMLVideoElement).videoWidth > 0),
          ),
      )
      .toBe(true);
    const phone = await phoneContext.newPage();
    await phone.goto(local(links.phoneUrl));
    await phone.getByRole("checkbox").check();
    await phone.getByRole("button", { name: "Connect desk camera" }).click();
    await expect(
      phone.getByRole("heading", { name: "Keep your workspace in view" }),
    ).toBeVisible();
    await expect
      .poll(() =>
        reviewer
          .locator(".camera-grid video")
          .evaluateAll(
            (videos) =>
              videos.filter((v) => (v as HTMLVideoElement).videoWidth > 0)
                .length,
          ),
      )
      .toBe(2);
    await expect
      .poll(
        async () => {
          const response = await reviewerContext.request.get(
            `https://localhost:3443/api/sessions/${session.id}`,
          );
          const data = await response.json();
          return new Set(
            data.recordings
              .filter((r: { bytes: number }) => r.bytes > 0)
              .map((r: { source: string }) => r.source),
          ).size;
        },
        { timeout: 20000 },
      )
      .toBe(3);
    await reviewer.screenshot({
      path: "test-results/live-synthetic-streams.png",
      fullPage: true,
    });
    await reviewer
      .getByRole("button", { name: "End interview", exact: true })
      .click();
    await reviewer
      .getByRole("dialog")
      .getByRole("button", { name: "End interview", exact: true })
      .click();
    await expect(
      laptop.getByRole("heading", { name: "Monitoring has ended" }),
    ).toBeVisible();
    await expect(
      phone.getByRole("heading", { name: "Monitoring has ended" }),
    ).toBeVisible();
    await expect
      .poll(
        async () => {
          const response = await reviewerContext.request.get(
            `https://localhost:3443/api/sessions/${session.id}`,
          );
          const data = await response.json();
          return data.recordings.filter(
            (r: { bytes: number; sha256: string | null }) =>
              r.bytes && r.sha256,
          ).length;
        },
        { timeout: 20000 },
      )
      .toBeGreaterThanOrEqual(3);
    await reviewer
      .getByRole("button", { name: "Recordings", exact: true })
      .click();
    await expect
      .poll(
        () =>
          reviewer
            .locator(".recording-card video")
            .evaluateAll(
              (videos) =>
                videos.filter(
                  (v) =>
                    (v as HTMLVideoElement).readyState >= 1 &&
                    (v as HTMLVideoElement).videoWidth > 0,
                ).length,
            ),
        { timeout: 15000 },
      )
      .toBeGreaterThanOrEqual(3);
    expect(browserErrors).toEqual([]);
  } finally {
    if (sessionId)
      await reviewerContext.request.delete(
        `https://localhost:3443/api/sessions/${sessionId}`,
      );
    await reviewerContext.close();
    await laptopContext.close();
    await phoneContext.close();
  }
});
