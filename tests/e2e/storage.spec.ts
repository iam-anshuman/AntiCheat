import { test, expect } from "@playwright/test";
import { resolve } from "node:path";

test("development server never serves private storage, even through Vite filesystem URLs", async ({
  request,
}) => {
  const privateRoot = resolve(".data").replace(/\\/g, "/");
  for (const path of [
    "/.data/admin-password",
    "/.data/clearview.sqlite",
    `/@fs/${privateRoot}/admin-password`,
    `/@fs/${privateRoot}/clearview.sqlite`,
    `/@fs/${privateRoot}/dev-key.pem`,
  ]) {
    const response = await request.get(path);
    expect(response.status(), `Private path must be rejected: ${path}`).toBe(
      403,
    );
  }
});
