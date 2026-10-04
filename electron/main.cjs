const {
  app,
  BrowserWindow,
  screen,
  session,
  desktopCapturer,
  ipcMain,
  dialog,
} = require("electron");
const { join, resolve } = require("node:path");
const { readFileSync, existsSync } = require("node:fs");
const { X509Certificate } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const run = promisify(execFile);
const serverUrl = process.env.CLEARVIEW_SERVER_URL || "https://localhost:3443";
let serverOrigin;
try {
  const parsed = new URL(serverUrl);
  if (parsed.protocol !== "https:") throw new Error();
  serverOrigin = parsed.origin;
} catch {
  throw new Error("CLEARVIEW_SERVER_URL must be a valid HTTPS address.");
}
let window,
  captureUntil = 0,
  cachedSystem,
  lastSystemRead = 0;
const trusted = (url) => {
  try {
    return new URL(url).origin === serverOrigin;
  } catch {
    return false;
  }
};
const assertCandidate = (event) => {
  if (
    event.sender !== window?.webContents ||
    event.senderFrame !== window.webContents.mainFrame ||
    !trusted(event.senderFrame.url) ||
    !new URL(event.senderFrame.url).pathname.startsWith("/join/")
  )
    throw new Error(
      "Desktop checks are available only in the candidate session.",
    );
};
async function systemInfo() {
  if (cachedSystem && Date.now() - lastSystemRead < 60_000) return cachedSystem;
  lastSystemRead = Date.now();
  if (process.platform !== "win32")
    return {
      vmIndicators: [],
      error:
        "System environment checks are supported on Windows in this pilot.",
    };
  try {
    const script =
      "$ErrorActionPreference='Stop'; $computer=Get-CimInstance Win32_ComputerSystem; $guard=$null; try { $guard=Get-CimInstance -Namespace root/Microsoft/Windows/DeviceGuard -ClassName Win32_DeviceGuard } catch {}; [pscustomobject]@{manufacturer=$computer.Manufacturer;model=$computer.Model;hypervisorPresent=[bool]$computer.HypervisorPresent;virtualizationSecurity=([int]$guard.VirtualizationBasedSecurityStatus -eq 2)} | ConvertTo-Json -Compress";
    const { stdout } = await run(
      join(
        process.env.SystemRoot || "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: 10_000, maxBuffer: 16_000 },
    );
    const facts = JSON.parse(stdout.trim());
    const text = `${facts.manufacturer || ""} ${facts.model || ""}`;
    const indicators = [
      /vmware/i,
      /virtualbox/i,
      /qemu/i,
      /parallels/i,
      /kvm/i,
      /virtual machine/i,
    ]
      .filter((pattern) => pattern.test(text))
      .map((pattern) => `Device manufacturer/model matches ${pattern.source}`);
    cachedSystem = {
      ...facts,
      vmIndicators: indicators,
      remoteSession: /^RDP-/i.test(process.env.SESSIONNAME || ""),
    };
  } catch {
    cachedSystem = {
      vmIndicators: [],
      error:
        "Windows environment checks could not be read. Display reporting remains available.",
    };
  }
  return cachedSystem;
}
app.whenReady().then(() => {
  // Pin only an explicitly supplied certificate or this workspace's local development certificate.
  // Never disable certificate checking globally.
  const certPath =
    process.env.CLEARVIEW_CERT_PATH || resolve(".data/dev-cert.pem");
  let pinned;
  if (existsSync(certPath))
    pinned = new X509Certificate(readFileSync(certPath)).fingerprint256;
  session.defaultSession.setCertificateVerifyProc((request, callback) => {
    if (request.verificationResult === "OK") return callback(0);
    try {
      const fingerprint = new X509Certificate(request.certificate.data)
        .fingerprint256;
      if (
        pinned &&
        request.hostname === new URL(serverOrigin).hostname &&
        fingerprint === pinned
      )
        return callback(0);
    } catch {}
    callback(-3);
  });
  session.defaultSession.setPermissionCheckHandler(
    (contents, permission, requestingOrigin) =>
      contents === window?.webContents &&
      trusted(requestingOrigin) &&
      ["media", "display-capture"].includes(permission),
  );
  session.defaultSession.setPermissionRequestHandler(
    (contents, permission, callback, details) =>
      callback(
        contents === window?.webContents &&
          trusted(details.requestingUrl) &&
          ["media", "display-capture"].includes(permission),
      ),
  );
  session.defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      if (
        !trusted(request.securityOrigin) ||
        request.frame !== window?.webContents.mainFrame ||
        Date.now() > captureUntil
      )
        return callback({});
      captureUntil = 0;
      try {
        const sources = await desktopCapturer.getSources({
          types: ["screen"],
          thumbnailSize: { width: 0, height: 0 },
        });
        const primary = String(screen.getPrimaryDisplay().id);
        const selected =
          sources.find((source) => source.display_id === primary) || sources[0];
        callback(selected ? { video: selected } : {});
      } catch {
        callback({});
      }
    },
  );
  window = new BrowserWindow({
    width: 1240,
    height: 900,
    minWidth: 740,
    minHeight: 600,
    backgroundColor: "#f5f6f8",
    title: "Clearview Candidate",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged,
    },
  });
  window.once("ready-to-show", () => {
    if (process.env.CLEARVIEW_HEADLESS_TEST !== "1") window.show();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (!trusted(url)) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  window.webContents.on("did-fail-load", (_event, code, description) => {
    if (code === -3) return;
    if (process.env.CLEARVIEW_HEADLESS_TEST === "1")
      console.error("Clearview connection failed:", description);
    else
      dialog.showErrorBox(
        "Clearview could not connect",
        `Start the Clearview server and check CLEARVIEW_SERVER_URL and certificate trust.\n\n${description}`,
      );
  });
  ipcMain.handle("clearview:arm-capture", (event) => {
    assertCandidate(event);
    captureUntil = Date.now() + 15_000;
  });
  ipcMain.handle("clearview:telemetry", async (event) => {
    assertCandidate(event);
    const primaryId = screen.getPrimaryDisplay().id;
    return {
      platform: process.platform,
      displays: screen
        .getAllDisplays()
        .map((d) => ({
          id: String(d.id),
          label: d.label || `Display ${d.id}`,
          width: d.size.width,
          height: d.size.height,
          primary: d.id === primaryId,
        })),
      system: await systemInfo(),
    };
  });
  for (const name of [
    "display-added",
    "display-removed",
    "display-metrics-changed",
  ])
    screen.on(name, () =>
      window?.webContents.send("clearview:displays-changed"),
    );
  window.loadURL(`${serverOrigin}/desktop`);
});
app.on("window-all-closed", () => app.quit());
