# Clearview — interview integrity pilot

A working first version of the desktop-app + phone-camera approach. Clearview brings a laptop camera, full-display share, phone desk camera, and Windows system indicators into an authenticated reviewer workspace. It records **observable events for human review** and makes no dishonesty, emotion, or hiring predictions.

## Run locally

Requires **Node.js 22.13 or newer**, npm, and Chrome or Edge for the reviewer. Windows is required for the native system-environment checks. The candidate desktop app is Electron; the phone uses its browser.

```powershell
npm.cmd install
# If npm reports blocked installation scripts:
npm.cmd install-scripts approve electron esbuild electron-winstaller
npm.cmd run models:setup
npm.cmd run dev
```

Open **https://localhost:3443**. First startup generates a local development certificate, SQLite database, and random reviewer password inside `.data/`. Read the password locally with:

```powershell
Get-Content .data/admin-password
```

Alternatively, set `ADMIN_PASSWORD` before the first run. Subsequent starts preserve the stored password hash; changing that variable does not overwrite an existing account. `.data/`, credentials, recordings, and local certificates are excluded from Git. Keep this directory private on the server computer.

1. Sign in and create an interview. Choose permitted resources, desk-camera requirements, recording, and retention.
2. Keep the session open in one reviewer tab. Copy its laptop invite to the candidate.
3. In another terminal, launch the candidate app:

   ```powershell
   npm.cmd run desktop
   ```

4. Paste the candidate invite in the desktop app. Accept the rules and start the camera. Click **Share entire screen** to explicitly share the primary display.
5. Scan the phone pairing QR code, accept its rules, and start the desk camera. Position the phone beside the candidate to show the hands, keyboard, and physical screen. Both camera views remain active throughout monitoring.
6. Review the event timeline, add bookmarks or notes, and dismiss or acknowledge observations with context. Open recordings, export the JSON evidence report, and end the interview when finished.

A candidate can also open the laptop invite in a browser to exercise video features. The dashboard records that native system context is unavailable. A connected device does not by itself mean its camera or screen capture is ready: confirm the actual feeds.

## Connect a real phone or another computer

Use the same Wi-Fi for the initial local pilot. The server prints its LAN HTTPS address, and QR links use that address. Set `PUBLIC_BASE_URL` in `.env` if the auto-selected network address is unsuitable, such as a virtual network adapter.

**Phone camera APIs need HTTPS with a trusted certificate.** Simply bypassing a certificate warning may not enable media capture. For local testing, transfer only `.data/dev-cert.pem` to your own test devices, install/trust it using the device's certificate settings, and verify the server address matches the certificate. Never transfer `.data/dev-key.pem` or the reviewer password to candidates. On iOS, a manually installed root also needs full trust enabled under Certificate Trust Settings. Remove the development certificate after testing. A new LAN address requires regenerating the development certificate and trusting the updated certificate.

Clearview refreshes its generated development certificate when it expires or the pairing hostname changes. Trust the updated public certificate on your test devices after a refresh. Clearview does not change firewall settings or install certificates automatically. If another device cannot reach the printed address, allow your Node server through the Windows firewall on your private test network.

For a candidate running the app on another Windows computer:

```powershell
$env:CLEARVIEW_SERVER_URL = 'https://your-server-address:3443'
# Local testing only: pin the server's development public certificate.
$env:CLEARVIEW_CERT_PATH = 'C:\path\to\dev-cert.pem'
npm.cmd run desktop
```

The app accepts valid trusted HTTPS certificates normally. Its development exception pins the exact public certificate for the configured hostname; certificate validation is never disabled globally.

## What is implemented

- Authenticated reviewer dashboard with searchable sessions, live connection states, session policies, and per-session invitations.
- Hashed, role-specific invite capabilities, 24-hour invite expiry, explicit consent, duplicate-device rejection, and revocation at interview end.
- WebRTC monitoring for laptop camera + screen and paired phone camera; reconnect handling and explicit stop controls. Microphone capture is disabled.
- Windows desktop telemetry: OS-reported displays, display-change events, manufacturer/model VM indicators, hypervisor presence, virtualization security, and remote-session environment indicator. Hypervisor presence alone is informational.
- Local MediaPipe face-count detection on the **reviewer's received laptop video**. Multiple visible faces persisting for 3 seconds produce a review observation; no detected face for 10 seconds produces a technical observation. There is a 30-second cooldown. No facial identity or emotion inference is performed.
- Event timestamps, interviewer bookmarks, review statuses, notes, and JSON evidence exports.
- Opt-in continuous recordings while the reviewer is connected, separate recordings for connection gaps, ordered/retried uploads, authenticated playback/download, and SHA-256 hashes after finalization. 500 MB limit per recording; the uploader stops if its queue exceeds 24 MB.
- Automatic removal of session records and recordings after the selected 1, 7, or 30 days **from creation**. A cleanup sweep runs at startup and every 30 seconds; media access is denied after expiry. Manual deletion removes the session immediately.

## Remote hosting

For a remote pilot, configure a reachable HTTPS server and a trusted certificate. A TURN service is usually needed across restrictive networks. ICE configuration is supplied only to authenticated reviewers or valid invited participants. Empty ICE configuration supports local-network testing; it does not guarantee remote connectivity.

Copy `.env.example` to `.env` and configure the variables below. Do not commit real credentials.

| Variable                        | Purpose                                               |
| ------------------------------- | ----------------------------------------------------- |
| `PUBLIC_BASE_URL`               | Canonical HTTPS address used for invites and QR codes |
| `PORT`                          | HTTPS listener port; default 3443                     |
| `TLS_CERT_PATH`, `TLS_KEY_PATH` | Trusted server certificate and private key            |
| `ADMIN_PASSWORD`                | Reviewer password on initial database setup           |
| `ICE_SERVERS_JSON`              | JSON array of authenticated STUN/TURN configuration   |
| `DATA_DIR`                      | Private database/recording directory; default `.data` |
| `NODE_ENV=production`           | Serve built assets and require configured TLS files   |

```powershell
npm.cmd run models:setup
npm.cmd run build
$env:NODE_ENV = 'production'
npm.cmd start
```

The production server requires explicit certificate configuration and does not automatically fall back to the development certificate. Use a publicly trusted certificate for a remote pilot. If deployed behind a proxy, preserve HTTPS and WebSocket support. This repository does not publish a site, provision a TURN service, or configure an external account.

Package the Windows candidate client with:

```powershell
npm.cmd run desktop:package
```

The portable executable appears in `release/`. This development package is **unsigned**; a public distribution needs your code-signing certificate and installer/update process. The candidate executable connects to a separately running Clearview server.

## Verification

```powershell
npm.cmd run typecheck
npm.cmd test
npx.cmd playwright install chromium
npm.cmd run test:e2e
npm.cmd run build
npm.cmd run test:production
npm.cmd audit
```

Backend tests cover authentication, consent and role enforcement, stable phone pairing, cross-session signaling, telemetry interpretation, recording opt-out, sequential/idempotent recording chunks, checksums, authenticated range playback, reviewer notes, invite revocation, logout, and retention deletion. Browser tests cover the reviewer workflow, mobile onboarding, three synthetic media streams with recording playback, native Windows display/system telemetry, and rejection of direct requests for private workspace storage. Browser screenshots are saved in `test-results/`.

The production smoke check uses a separate temporary database and synthetic camera to verify the compiled UI, authenticated HTTPS, WebRTC, local face model/WASM, and production content security policy. It requires a previous local startup to create the test certificate and a completed build; it does not record a real camera.

Before a paid pilot, test actual Windows hardware plus iPhone/Android devices, display connection/disconnection, denied media permission, Wi-Fi drops, poor lighting, phone suspension, and real remote networks using your TURN service. Measure setup completion, technical failures, missed staged events, false observations, and review time. Automated tests use synthetic media when exercising WebRTC; they do not establish detection accuracy on real people.

## Architecture and boundaries

React/Vite frontend, HTTPS Express + Socket.IO signaling service, Node's built-in SQLite, WebRTC media transport, and a context-isolated Electron candidate app. Models and WASM are served locally after `models:setup`; video frames are not sent to a model provider. The server receives recordings uploaded by the reviewer. Live video travels between the participant and reviewer or through your configured TURN relay.

This is a **single-organization pilot** with one shared reviewer account. Use one reviewer tab per active interview to avoid duplicate recordings. It has no billing, multi-tenant isolation, staff roles, audit signing, external meeting integration, or managed deployment. Reviewers must stay connected for detection and recording; browser shutdown can lose the last recording chunk, and the database marks incomplete recordings ended after a server restart. Recording hashes detect later file changes but do not prove the source device or capture time was authentic.

The desktop client observes the candidate OS environment. It cannot independently attest an unmodified OS, enumerate hidden physical devices, or guarantee absence of a VM. Phone cameras provide visual evidence; automatic phone-object detection is not implemented. A visible assistant, multiple displays, or a virtualization indicator must be interpreted using the agreed interview rules. No reliable detection of arbitrary GPT usage, capture-hidden overlays, or cheating from answer wording is claimed. Connection errors, face-detector failures, and missing feeds are technical observations, not misconduct conclusions.

MediaPipe's model and WASM assets are downloaded from Google's model repository and the installed `@mediapipe/tasks-vision` package. See their upstream licenses before redistribution. Candidate recordings and consent handling should be validated for your intended customers and jurisdiction before commercial deployment.
