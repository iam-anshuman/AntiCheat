import { test, expect, _electron as electron } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("Windows desktop accepts LAN invitations and reports real system context without capturing a real camera", async ({
  request,
}) => {
  test.skip(
    process.platform !== "win32",
    "Windows environment checks are Windows-specific.",
  );
  const password =
    process.env.ADMIN_PASSWORD ||
    readFileSync(".data/admin-password", "utf8").trim();
  await request.post("/api/auth/login", { data: { password } });
  const response = await request.post("/api/sessions", {
    data: {
      candidateName: "Desktop Integration Test",
      roleTitle: "Native context validation",
      policy: {
        aiAllowed: false,
        extraDisplaysAllowed: false,
        phoneRequired: false,
        recordingEnabled: false,
        retentionDays: 1,
      },
    },
  });
  const { session, links } = await response.json();
  const app = await electron.launch({
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      resolve("electron/main.cjs"),
    ],
    env: {
      ...process.env,
      CLEARVIEW_SERVER_URL: "https://localhost:3443",
      CLEARVIEW_HEADLESS_TEST: "1",
    },
  });
  try {
    const window = await app.firstWindow();
    await window.waitForURL("**/desktop", { timeout: 20000 });
    await window.waitForLoadState("domcontentloaded");
    await expect(
      window.getByRole("heading", { name: "Join your interview", exact: true }),
    ).toBeVisible({ timeout: 20000 });
    await expect(
      window.getByText("Desktop checks are available.", { exact: false }),
    ).toBeVisible();
    // The API's canonical LAN invitation must work in the same server's localhost window.
    await window.getByLabel("Candidate invite link").fill(links.candidateUrl);
    await window.getByRole("button", { name: "Review session rules" }).click();
    await expect(
      window.getByRole("heading", { name: "Welcome, Desktop" }),
    ).toBeVisible();
    const facts = await window.evaluate(() =>
      window.clearviewDesktop!.telemetry(),
    );
    expect(facts.platform).toBe("win32");
    expect(facts.displays.length).toBeGreaterThan(0);
    expect(facts.displays.some((d) => d.primary)).toBe(true);
    expect(facts.system).toHaveProperty("vmIndicators");
    await window.getByRole("checkbox").check();
    await window
      .getByRole("button", { name: "Join monitoring session" })
      .click();
    await expect(
      window.getByRole("heading", { name: "You’re connected" }),
    ).toBeVisible();
    await expect
      .poll(
        async () => {
          const detail = await request.get(`/api/sessions/${session.id}`);
          return (await detail.json()).telemetry?.displays?.length || 0;
        },
        { timeout: 20000 },
      )
      .toBeGreaterThan(0);
    await request.post(`/api/sessions/${session.id}/end`);
    await expect(
      window.getByRole("heading", { name: "Monitoring has ended" }),
    ).toBeVisible();
  } finally {
    await app.close();
    await request.delete(`/api/sessions/${session.id}`);
  }
});
