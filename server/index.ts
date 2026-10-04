import { createServer } from "node:https";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { X509Certificate } from "node:crypto";
import { isIP } from "node:net";
import { resolve, join, sep } from "node:path";
import selfsigned from "selfsigned";
import express from "express";
import { Store } from "./store.js";
import { createService } from "./app.js";

// Small .env reader: no shell evaluation and no accidental secret logging.
if (existsSync(".env"))
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match && !process.env[match[1]])
      process.env[match[1]] = match[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
const directory = resolve(process.env.DATA_DIR || ".data");
for (const publicDirectory of [resolve("public"), resolve("dist")]) {
  if (
    directory === publicDirectory ||
    directory.startsWith(publicDirectory + sep)
  )
    throw new Error("DATA_DIR must be outside public and dist directories.");
}
mkdirSync(directory, { recursive: true });
const adapters = Object.entries(networkInterfaces()).sort(
  ([a], [b]) =>
    Number(/virtual|vmware|vmnet|vethernet|wsl|tailscale|zerotier/i.test(a)) -
    Number(/virtual|vmware|vmnet|vethernet|wsl|tailscale|zerotier/i.test(b)),
);
const addresses = adapters
  .flatMap(([, values]) => values || [])
  .filter((a) => !a.internal && a.family === "IPv4")
  .map((a) => a.address);
const port = Number(process.env.PORT || 3443);
const publicBaseUrl = (
  process.env.PUBLIC_BASE_URL ||
  `https://${addresses[0] || "localhost"}:${port}`
).replace(/\/$/, "");
if (new URL(publicBaseUrl).protocol !== "https:")
  throw new Error("PUBLIC_BASE_URL must use HTTPS for phone camera access.");
let key: string | Buffer, cert: string | Buffer;
if (process.env.TLS_CERT_PATH && process.env.TLS_KEY_PATH) {
  cert = readFileSync(process.env.TLS_CERT_PATH);
  key = readFileSync(process.env.TLS_KEY_PATH);
} else {
  if (process.env.NODE_ENV === "production")
    throw new Error(
      "Production requires TLS_CERT_PATH and TLS_KEY_PATH with a trusted certificate.",
    );
  const certFile = join(directory, "dev-cert.pem"),
    keyFile = join(directory, "dev-key.pem");
  const publicHostname = new URL(publicBaseUrl).hostname;
  let needsCertificate = !existsSync(certFile) || !existsSync(keyFile);
  if (!needsCertificate) {
    try {
      const existing = new X509Certificate(readFileSync(certFile));
      needsCertificate =
        Date.parse(existing.validTo) <= Date.now() ||
        !(isIP(publicHostname)
          ? existing.checkIP(publicHostname)
          : existing.checkHost(publicHostname));
    } catch {
      needsCertificate = true;
    }
  }
  if (needsCertificate) {
    const pems = await selfsigned.generate(
      [{ name: "commonName", value: "Clearview local development" }],
      {
        notAfterDate: new Date(Date.now() + 90 * 86400000),
        keySize: 2048,
        algorithm: "sha256",
        extensions: [
          { name: "basicConstraints", cA: true },
          {
            name: "keyUsage",
            digitalSignature: true,
            keyEncipherment: true,
            keyCertSign: true,
          },
          { name: "extKeyUsage", serverAuth: true },
          {
            name: "subjectAltName",
            altNames: [
              { type: 2, value: "localhost" },
              { type: 7, ip: "127.0.0.1" },
              ...(isIP(publicHostname)
                ? [{ type: 7 as const, ip: publicHostname }]
                : [{ type: 2 as const, value: publicHostname }]),
              ...addresses.map((ip) => ({ type: 7 as const, ip })),
            ],
          },
        ],
      },
    );
    writeFileSync(certFile, pems.cert);
    writeFileSync(keyFile, pems.private, { mode: 0o600 });
    console.log(
      "Local certificate generated or refreshed. Trust .data/dev-cert.pem on your test devices.",
    );
  }
  cert = readFileSync(certFile);
  key = readFileSync(keyFile);
}
const store = new Store(directory, process.env.ADMIN_PASSWORD);
const iceServers = process.env.ICE_SERVERS_JSON
  ? JSON.parse(process.env.ICE_SERVERS_JSON)
  : [];
const service = createService({
  store,
  publicBaseUrl,
  iceServers,
  production: process.env.NODE_ENV === "production",
});
const server = createServer({ key, cert }, service.app);
service.attach(server);
if (process.env.NODE_ENV !== "production") {
  console.log("Preparing the web workspace…");
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    server: {
      middlewareMode: true,
      hmr: { server },
      fs: { deny: [directory.replace(/\\/g, "/") + "/**"] },
    },
    appType: "spa",
  });
  service.app.use(vite.middlewares);
  console.log("Web workspace prepared.");
} else {
  service.app.use(express.static(resolve("dist")));
  service.app.get("/{*path}", (_req, res) =>
    res.sendFile(resolve("dist/index.html")),
  );
}
await service.sweep();
const timer = setInterval(() => {
  service
    .sweep()
    .catch((err) => console.error("Retention cleanup failed:", err.message));
}, 30_000);
server.listen(port, "0.0.0.0", () => {
  console.log(`Clearview ready: https://localhost:${port}`);
  console.log(`Phone / LAN address: ${publicBaseUrl}`);
  console.log(
    "Reviewer password: use ADMIN_PASSWORD or read .data/admin-password.",
  );
});
const shutdown = async () => {
  clearInterval(timer);
  await service.close();
  store.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
