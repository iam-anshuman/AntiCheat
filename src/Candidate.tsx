import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { io, type Socket } from "socket.io-client";
import { QRCodeSVG } from "qrcode.react";
import {
  Camera,
  Smartphone,
  Monitor,
  ShieldCheck,
  ArrowRight,
  Check,
  Square,
  Info,
  RefreshCw,
  LockKeyhole,
  CheckCircle2,
  ExternalLink,
} from "lucide-react";
import type { Invite, Role, Source, AppConfig } from "../shared/types";
import { api, post, formatDate } from "./api";
import { Brand, CopyButton, ErrorNotice, Feed } from "./components";
import { Broadcast } from "./media";

export function DesktopWelcome() {
  const [url, setUrl] = useState(""),
    [error, setError] = useState("");
  const navigate = useNavigate();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const target = new URL(url);
      const config = await api<AppConfig>("/api/config");
      const allowedOrigins = [
        location.origin,
        new URL(config.publicBaseUrl).origin,
      ];
      if (
        !allowedOrigins.includes(target.origin) ||
        !/^\/join\/[A-Za-z0-9_-]{43}$/.test(target.pathname)
      )
        throw new Error("Paste a laptop invite from this Clearview server.");
      navigate(target.pathname);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <div className="participant-page">
      <header className="participant-header">
        <Brand />
        <span className="badge waiting">Candidate desktop</span>
      </header>
      <main className="desktop-welcome">
        <span className="welcome-icon">
          <Monitor size={35} />
        </span>
        <span className="eyebrow">YOUR INTERVIEW, IN VIEW</span>
        <h1>Join your interview</h1>
        <p>
          Paste the laptop invite shared by your interviewer. You’ll review the
          session rules before any monitoring starts.
        </p>
        <form onSubmit={submit}>
          <label>
            Candidate invite link
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              type="url"
              required
              placeholder={`${location.origin}/join/…`}
            />
          </label>
          <ErrorNotice message={error} />
          <button className="button primary">
            Review session rules
            <ArrowRight size={17} />
          </button>
        </form>
        <div className="notice">
          <Info size={16} />
          {window.clearviewDesktop
            ? "Desktop checks are available. Monitoring starts only after you accept the rules."
            : "You are in a browser. Use npm run desktop to launch the Windows client with system checks."}
        </div>
      </main>
    </div>
  );
}
export function CandidatePage({ role }: { role: "laptop" | "phone" }) {
  const { token } = useParams<{ token: string }>();
  const [invite, setInvite] = useState<Invite>(),
    [error, setError] = useState(""),
    [accepted, setAccepted] = useState(false),
    [started, setStarted] = useState(false),
    [busy, setBusy] = useState(false),
    [connected, setConnected] = useState(false),
    [ended, setEnded] = useState(false),
    [viewerCount, setViewerCount] = useState(0),
    [phoneConnected, setPhoneConnected] = useState(false),
    [phoneUrl, setPhoneUrl] = useState(""),
    [facing, setFacing] = useState("environment");
  const [streams, setStreams] = useState<Partial<Record<Source, MediaStream>>>(
    {},
  );
  const streamMap = useRef(new Map<Source, MediaStream>()),
    socket = useRef<Socket | undefined>(undefined),
    broadcast = useRef<Broadcast | undefined>(undefined);
  const telemetryTimer = useRef<ReturnType<typeof setInterval> | undefined>(
      undefined,
    ),
    unwatch = useRef<(() => void) | undefined>(undefined);
  const observe = (kind: string, detail: string) => {
    if (socket.current?.connected)
      socket.current.emit("observation", { kind, detail });
  };
  const sync = () => {
    setStreams(Object.fromEntries(streamMap.current));
    broadcast.current?.setStreams(new Map(streamMap.current));
  };
  const stopCapture = () => {
    for (const stream of streamMap.current.values())
      for (const track of stream.getTracks()) track.stop();
    streamMap.current.clear();
    sync();
  };
  useEffect(() => {
    setError("");
    api<Invite>(`/api/invites/${token}`)
      .then((data) => {
        if (data.role !== role)
          throw new Error(
            "This invite belongs to a different device role. Use the link supplied for this device.",
          );
        setInvite(data);
      })
      .catch((e) => setError(e.message));
    return () => {
      for (const stream of streamMap.current.values())
        stream.getTracks().forEach((t) => t.stop());
      streamMap.current.clear();
      broadcast.current?.close();
      socket.current?.disconnect();
      clearInterval(telemetryTimer.current);
      unwatch.current?.();
    };
  }, [token, role]);
  const addCamera = async () => {
    try {
      const source: Source = role === "phone" ? "desk-camera" : "laptop-camera";
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 960 },
          height: { ideal: 540 },
          frameRate: { ideal: 15, max: 24 },
          ...(role === "phone" ? { facingMode: { ideal: facing } } : {}),
        },
        audio: false,
      });
      streamMap.current
        .get(source)
        ?.getTracks()
        .forEach((t) => t.stop());
      streamMap.current.set(source, stream);
      const track = stream.getVideoTracks()[0];
      track.onended = () => {
        if (streamMap.current.get(source) === stream) {
          streamMap.current.delete(source);
          sync();
          observe(
            "camera_stopped",
            "The camera track ended. Check device permissions and reconnect the feed.",
          );
        }
      };
      track.onmute = () =>
        observe(
          "camera_muted",
          "Camera capture is temporarily unavailable. Check device or browser conditions.",
        );
      sync();
      observe(
        "camera_started",
        `${role === "phone" ? "Desk" : "Laptop"} camera capture started. Microphone capture is disabled.`,
      );
    } catch (err) {
      const message = `Camera could not start: ${(err as Error).message}`;
      setError(message);
      observe("capture_failed", message);
    }
  };
  const addScreen = async () => {
    try {
      await window.clearviewDesktop?.allowScreenCapture();
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: "monitor", frameRate: { ideal: 10, max: 15 } },
        audio: false,
      });
      const track = stream.getVideoTracks()[0];
      if (
        !window.clearviewDesktop &&
        track.getSettings().displaySurface !== "monitor"
      ) {
        stream.getTracks().forEach((t) => t.stop());
        throw new Error(
          "Choose your entire screen rather than a single tab or window.",
        );
      }
      streamMap.current
        .get("screen")
        ?.getTracks()
        .forEach((t) => t.stop());
      streamMap.current.set("screen", stream);
      track.onended = () => {
        if (streamMap.current.get("screen") === stream) {
          streamMap.current.delete("screen");
          sync();
          observe(
            "screen_stopped",
            "Screen sharing ended. The candidate can reconnect sharing.",
          );
        }
      };
      sync();
      observe("screen_started", "Candidate started full-display sharing.");
    } catch (err) {
      const message = `Screen sharing could not start: ${(err as Error).message}`;
      setError(message);
      observe("capture_failed", message);
    }
  };
  const sendTelemetry = async () => {
    if (window.clearviewDesktop && socket.current?.connected) {
      try {
        socket.current.emit(
          "telemetry",
          await window.clearviewDesktop.telemetry(),
        );
      } catch (err) {
        observe(
          "desktop_unavailable",
          `System context could not be read: ${(err as Error).message}`,
        );
      }
    }
  };
  const start = async () => {
    if (!accepted || !invite || busy) return;
    setBusy(true);
    setError("");
    try {
      await post(`/api/invites/${token}/consent`, { accepted: true });
      const client = io({ autoConnect: false, auth: { role, token } });
      socket.current?.disconnect();
      broadcast.current?.close();
      socket.current = client;
      broadcast.current = new Broadcast(client, invite.iceServers, setError);
      client.on("connect", () => {
        setConnected(true);
        void sendTelemetry();
        if (role === "laptop" && !window.clearviewDesktop)
          observe(
            "desktop_unavailable",
            "Candidate joined in a browser. OS display and system environment checks are unavailable.",
          );
        // Report already active tracks after reconnection.
        for (const source of streamMap.current.keys())
          observe(
            source === "screen" ? "screen_started" : "camera_started",
            `${source} active after connection established.`,
          );
      });
      client.on("disconnect", (reason: string) => {
        setConnected(false);
        if (reason === "io server disconnect") {
          stopCapture();
          setEnded(true);
        }
      });
      client.on("connect_error", (e) => setError(e.message));
      client.on("monitor-error", (message: string) => setError(message));
      client.on("participants", (peers: { id: string; role: Role }[]) => {
        setViewerCount(peers.filter((p) => p.role === "reviewer").length);
        setPhoneConnected(peers.some((p) => p.role === "phone"));
      });
      client.on("session-ended", () => {
        stopCapture();
        setEnded(true);
        clearInterval(telemetryTimer.current);
      });
      client.connect();
      setStarted(true);
      if (role === "laptop") {
        clearInterval(telemetryTimer.current);
        telemetryTimer.current = setInterval(sendTelemetry, 15_000);
        unwatch.current?.();
        unwatch.current = window.clearviewDesktop?.onDisplaysChanged(() => {
          void sendTelemetry();
        });
        const pairing = await post<{ phoneUrl: string }>(
          `/api/invites/${token}/phone`,
        ).catch(() => null);
        if (pairing) setPhoneUrl(pairing.phoneUrl);
      }
      await addCamera();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const leave = () => {
    observe(
      "camera_stopped",
      "Candidate stopped monitoring using the session controls.",
    );
    if (streamMap.current.has("screen"))
      observe(
        "screen_stopped",
        "Candidate stopped screen sharing using the session controls.",
      );
    stopCapture();
    broadcast.current?.close();
    socket.current?.disconnect();
    clearInterval(telemetryTimer.current);
    unwatch.current?.();
    setStarted(false);
    setConnected(false);
  };
  return (
    <div className={`participant-page ${role === "phone" ? "phone-page" : ""}`}>
      <header className="participant-header">
        <Brand />
        <span className={`badge ${connected ? "live" : "waiting"}`}>
          <i />
          {role === "phone" ? "Desk camera" : "Candidate workspace"}
        </span>
      </header>
      <main className="participant-main">
        {ended ? (
          <div className="completion">
            <CheckCircle2 size={52} />
            <h1>Monitoring has ended</h1>
            <p>
              Your camera and screen capture have stopped. Thank you for
              joining.
            </p>
            <small>
              Session data is scheduled for deletion on{" "}
              {invite
                ? formatDate(invite.session.expiresAt)
                : "the agreed retention date"}
              .
            </small>
          </div>
        ) : !invite ? (
          <div className="desktop-welcome">
            <ErrorNotice message={error} />
            {!error && <p>Loading your interview…</p>}
          </div>
        ) : !started ? (
          <div className="onboarding">
            <div className="onboarding-title">
              <span className="eyebrow">
                {role === "phone" ? "A SECOND PERSPECTIVE" : "BEFORE YOU JOIN"}
              </span>
              <h1>
                {role === "phone"
                  ? "Set up your desk camera"
                  : `Welcome, ${invite.session.candidateName.split(" ")[0]}`}
              </h1>
              <p>
                {invite.session.roleTitle} · Interview monitoring with Clearview
              </p>
            </div>
            <div className="onboarding-grid">
              <section className="panel consent-card">
                <h2>
                  <ShieldCheck size={22} />
                  Know what’s in view
                </h2>
                <p>
                  Your interviewer will see these monitoring views. Recording is{" "}
                  {invite.session.policy.recordingEnabled
                    ? "enabled while a reviewer is connected"
                    : "disabled for this session"}
                  .
                </p>
                <div className="consent-item">
                  <Camera size={20} />
                  <div>
                    <strong>
                      {role === "phone" ? "Desk camera" : "Laptop camera"}
                    </strong>
                    <p>
                      {role === "phone"
                        ? "Show your hands, keyboard, laptop screen, and desk from a side angle."
                        : "Keep your face in view. The system may flag multiple visible faces or a missing face for review."}
                    </p>
                  </div>
                </div>
                {role === "laptop" && (
                  <>
                    <div className="consent-item">
                      <Monitor size={20} />
                      <div>
                        <strong>Full-screen sharing & system context</strong>
                        <p>
                          Share your entire display. The desktop app also
                          reports connected displays, device model, and
                          virtualization or remote-session indicators.
                        </p>
                      </div>
                    </div>
                    <div className="consent-item">
                      <Smartphone size={20} />
                      <div>
                        <strong>
                          Phone desk camera ·{" "}
                          {invite.session.policy.phoneRequired
                            ? "required"
                            : "optional"}
                        </strong>
                        <p>
                          Pair your phone after joining. Connect it to power and
                          position it securely beside the laptop.
                        </p>
                      </div>
                    </div>
                  </>
                )}
                <div className="consent-item">
                  <LockKeyhole size={20} />
                  <div>
                    <strong>Access & deletion</strong>
                    <p>
                      Only signed-in reviewers can access stored evidence.
                      Session data is deleted on{" "}
                      {formatDate(invite.session.expiresAt)}. No microphone
                      audio or global keystrokes are recorded.
                    </p>
                  </div>
                </div>
              </section>
              <section className="panel rules-card">
                <span className="eyebrow">SESSION RULES</span>
                <h2>Expectations, made clear.</h2>
                <div className="rule">
                  <span>AI assistance</span>
                  <strong>
                    {invite.session.policy.aiAllowed
                      ? "Allowed"
                      : "Not allowed"}
                  </strong>
                </div>
                <div className="rule">
                  <span>Additional displays</span>
                  <strong>
                    {invite.session.policy.extraDisplaysAllowed
                      ? "Allowed"
                      : "Not allowed"}
                  </strong>
                </div>
                <div className="rule">
                  <span>Desk camera</span>
                  <strong>
                    {invite.session.policy.phoneRequired
                      ? "Required"
                      : "Optional"}
                  </strong>
                </div>
                <div className="notice">
                  <Info size={16} />
                  Connection issues and automated observations need human
                  review. Clearview does not decide whether you cheated.
                </div>
                {role === "phone" && (
                  <label>
                    Camera to use
                    <select
                      value={facing}
                      onChange={(e) => setFacing(e.target.value)}
                    >
                      <option value="environment">Back camera</option>
                      <option value="user">Front camera</option>
                    </select>
                  </label>
                )}
                {role === "laptop" && !window.clearviewDesktop && (
                  <div className="notice">
                    Browser mode provides video and screen sharing. Use the
                    Clearview desktop app for system checks.
                  </div>
                )}
                <label className="consent-checkbox">
                  <input
                    type="checkbox"
                    checked={accepted}
                    onChange={(e) => setAccepted(e.target.checked)}
                  />
                  <span>
                    I have read the rules and agree to the monitoring and
                    recording policy described above.
                  </span>
                </label>
                <ErrorNotice message={error} />
                <button
                  className="button primary"
                  onClick={start}
                  disabled={!accepted || busy}
                >
                  {busy
                    ? "Connecting…"
                    : role === "phone"
                      ? "Connect desk camera"
                      : "Join monitoring session"}
                  <ArrowRight size={17} />
                </button>
              </section>
            </div>
          </div>
        ) : (
          <>
            <div className="page-heading">
              <div>
                <span className="eyebrow">
                  {role === "phone" ? "DESK CAMERA" : "YOUR MONITORING SESSION"}
                </span>
                <h1>
                  {role === "phone"
                    ? "Keep your workspace in view"
                    : "You’re connected"}
                </h1>
                <p>
                  {invite.session.candidateName} ·{" "}
                  {viewerCount
                    ? `${viewerCount} reviewer${viewerCount === 1 ? "" : "s"} connected`
                    : "Waiting for your interviewer to open the workspace"}
                </p>
              </div>
              <button className="button secondary" onClick={leave}>
                <Square size={14} />
                Stop monitoring
              </button>
            </div>
            <ErrorNotice message={error} />
            {!connected && (
              <div className="notice error">
                Monitoring connection lost. Reconnecting… Check your network.
                Video is not reaching the interviewer while disconnected.
              </div>
            )}
            <div className="participant-live">
              <div>
                <Feed
                  source={role === "phone" ? "desk-camera" : "laptop-camera"}
                  stream={
                    streams[role === "phone" ? "desk-camera" : "laptop-camera"]
                  }
                  live={false}
                />
                <div className="camera-controls">
                  <button
                    className="button secondary"
                    onClick={() => {
                      setError("");
                      void addCamera();
                    }}
                  >
                    <RefreshCw size={15} />
                    Reconnect camera
                  </button>
                  <span>
                    <Check size={14} />
                    Microphone off
                  </span>
                </div>
                {role === "laptop" && (
                  <>
                    <Feed
                      source="screen"
                      stream={streams.screen}
                      live={false}
                    />
                    <button
                      className="button primary share-screen"
                      onClick={() => {
                        setError("");
                        void addScreen();
                      }}
                    >
                      <Monitor size={16} />
                      {streams.screen
                        ? "Replace screen share"
                        : "Share entire screen"}
                    </button>
                  </>
                )}
                {role === "phone" && (
                  <div className="notice">
                    <Smartphone size={18} />
                    Keep the phone on this page, connected to power, with the
                    camera unobstructed. Make sure the hands, keyboard, and
                    laptop screen are visible.
                  </div>
                )}
              </div>
              {role === "laptop" && (
                <aside className="panel pairing-card">
                  <span className="eyebrow">SECOND CAMERA</span>
                  <h2>
                    {phoneConnected
                      ? "Desk camera connected"
                      : "Pair your phone"}
                  </h2>
                  <p>
                    Scan this code with your phone and accept the monitoring
                    rules there.
                  </p>
                  {phoneUrl ? (
                    <>
                      <div className="pairing-qr">
                        <QRCodeSVG value={phoneUrl} size={180} marginSize={2} />
                      </div>
                      <CopyButton value={phoneUrl} label="Copy phone link" />
                      <input
                        readOnly
                        value={phoneUrl}
                        aria-label="Phone pairing URL"
                      />
                    </>
                  ) : (
                    <button
                      className="button secondary"
                      disabled={phoneConnected}
                      onClick={async () => {
                        try {
                          const pairing = await post<{ phoneUrl: string }>(
                            `/api/invites/${token}/phone`,
                          );
                          setPhoneUrl(pairing.phoneUrl);
                        } catch (err) {
                          setError((err as Error).message);
                        }
                      }}
                    >
                      Generate pairing link
                    </button>
                  )}
                  <ol>
                    <li>Use the same Wi-Fi for a local session.</li>
                    <li>
                      Place the phone beside you, facing the keyboard and
                      screen.
                    </li>
                    <li>Check the preview, then keep this page open.</li>
                  </ol>
                  <div className={`notice ${phoneConnected ? "success" : ""}`}>
                    {phoneConnected ? (
                      <>
                        <CheckCircle2 size={17} />
                        Desk camera device is connected.
                      </>
                    ) : (
                      <>
                        <Info size={17} />
                        {invite.session.policy.phoneRequired
                          ? "Your interview requires this view."
                          : "This view is optional for this interview."}
                      </>
                    )}
                  </div>
                </aside>
              )}
            </div>
          </>
        )}
      </main>
      <footer className="participant-footer">
        <ShieldCheck size={14} />
        Consent-based monitoring · Decisions stay with your interviewer.
      </footer>
    </div>
  );
}
