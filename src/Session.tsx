import { useEffect, useRef, useState } from "react";
import { useLocation, useParams, Link, useNavigate } from "react-router-dom";
import { io } from "socket.io-client";
import { QRCodeSVG } from "qrcode.react";
import {
  ArrowLeft,
  UserPlus,
  Square,
  Download,
  Bookmark,
  Monitor,
  Smartphone,
  ShieldCheck,
  Circle,
  Film,
  Trash2,
  Activity,
  ChevronRight,
  Clock,
  Info,
  Play,
  Check,
  EyeOff,
} from "lucide-react";
import type {
  SessionDetail,
  Source,
  EvidenceEvent,
  Recording,
} from "../shared/types";
import type { InviteLinks } from "./App";
import { Status } from "./App";
import { api, post, formatTime, formatDate, sourceName } from "./api";
import { CopyButton, ErrorNotice, Feed, Modal } from "./components";
import { Viewer, EvidenceRecorder } from "./media";

export function SessionPage() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation(),
    navigate = useNavigate();
  const [detail, setDetail] = useState<SessionDetail>(),
    [error, setError] = useState(""),
    [connected, setConnected] = useState(false);
  const [streams, setStreams] = useState<
    Partial<Record<Source, MediaStream | null>>
  >({});
  const [visionState, setVisionState] = useState("inactive");
  const [links, setLinks] = useState<InviteLinks | null>(
    (location.state as { links?: InviteLinks } | null)?.links || null,
  );
  const [showInvite, setShowInvite] = useState(Boolean(links)),
    [busy, setBusy] = useState(false),
    [filter, setFilter] = useState("all");
  const [selectedEvent, setSelectedEvent] = useState<EvidenceEvent | null>(
      null,
    ),
    [playback, setPlayback] = useState<{ at?: string } | null>(null),
    [endConfirm, setEndConfirm] = useState(false),
    [deleteConfirm, setDeleteConfirm] = useState(false),
    [bookmark, setBookmark] = useState(false),
    [note, setNote] = useState("");
  const detailRef = useRef(detail);
  detailRef.current = detail;
  const recorders = useRef(
    new Map<Source, { stream: MediaStream; recorder: EvidenceRecorder }>(),
  );
  const mounted = useRef(true);
  const load = () =>
    api<SessionDetail>(`/api/sessions/${id}`)
      .then((r) => {
        if (mounted.current) setDetail(r);
      })
      .catch((e) => {
        if (mounted.current) setError(e.message);
      });
  useEffect(() => {
    mounted.current = true;
    void load();
    const timer = setInterval(load, 5000);
    let closed = false,
      viewer: Viewer | undefined;
    const socket = io({
      autoConnect: false,
      auth: { role: "reviewer", sessionId: id },
    });
    socket.on("updated", load);
    socket.on("connect", () => setConnected(true));
    socket.on("disconnect", () => setConnected(false));
    socket.on("connect_error", (e) => setError(e.message));
    api<RTCIceServer[]>("/api/ice")
      .then((ice) => {
        if (closed) return;
        viewer = new Viewer(
          socket,
          ice,
          (source, stream) => setStreams((s) => ({ ...s, [source]: stream })),
          (message) => {
            setError(message);
            void post(`/api/sessions/${id}/events`, {
              kind: "peer_failed",
              detail: message,
            }).catch(() => {});
          },
        );
        socket.connect();
      })
      .catch((e) => setError(e.message));
    return () => {
      closed = true;
      mounted.current = false;
      clearInterval(timer);
      viewer?.close();
      socket.disconnect();
      for (const r of recorders.current.values()) r.recorder.stop();
      recorders.current.clear();
    };
    // Each route owns one viewer and one polling fallback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  useEffect(() => {
    for (const [source, active] of recorders.current)
      if (
        streams[source] !== active.stream ||
        detail?.session.state === "ended"
      ) {
        active.recorder.stop();
        recorders.current.delete(source);
      }
    if (
      detail?.session.policy.recordingEnabled &&
      detail.session.state !== "ended"
    )
      for (const [source, stream] of Object.entries(streams) as [
        Source,
        MediaStream | null,
      ][]) {
        if (!stream || recorders.current.has(source)) continue;
        const recorder = new EvidenceRecorder(id!, source, (message) => {
          setError(message);
          void post(`/api/sessions/${id}/events`, {
            kind: "recording_failed",
            detail: `${sourceName[source]}: ${message}`,
          }).catch(() => {});
        });
        recorders.current.set(source, { stream, recorder });
        void recorder.start(stream);
      }
  }, [
    streams,
    detail?.session.policy.recordingEnabled,
    detail?.session.state,
    id,
  ]);
  useEffect(() => {
    const stream = streams["laptop-camera"];
    if (!stream || detail?.session.state === "ended") {
      setVisionState("inactive");
      return;
    }
    setVisionState("starting");
    let stopped = false,
      cleanup: (() => void) | undefined;
    import("./vision")
      .then(({ watchFaces }) =>
        watchFaces(stream, (kind, detail, count) => {
          void post(`/api/sessions/${id}/events`, {
            kind,
            detail,
            data: { count },
          }).catch(() => {});
        }),
      )
      .then((stop) => {
        if (stopped) stop();
        else {
          cleanup = stop;
          setVisionState("active");
        }
      })
      .catch(() => {
        if (!stopped) {
          setVisionState("unavailable");
          setError(
            "Face detection could not start. Video and manual review remain available. Run npm run models:setup to install the local model.",
          );
          void post(`/api/sessions/${id}/events`, {
            kind: "vision_unavailable",
            detail:
              "The local face detector could not initialize. Manual video review remains available.",
          }).catch(() => {});
        }
      });
    return () => {
      stopped = true;
      cleanup?.();
    };
  }, [streams["laptop-camera"], detail?.session.state, id]);
  if (!detail)
    return (
      <main className="page">
        <Link className="back-link" to="/sessions">
          <ArrowLeft size={16} />
          All interviews
        </Link>
        <ErrorNotice message={error} />
        <div className="empty-state">Loading interview…</div>
      </main>
    );
  const { session, events, telemetry, recordings } = detail;
  const unreviewed = events.filter(
    (e) => e.level === "review" && e.reviewStatus === "unreviewed",
  ).length;
  const filtered = events.filter(
    (e) =>
      filter === "all" ||
      (filter === "review" ? e.level === "review" : e.level === "technical"),
  );
  const invite = async () => {
    if (links) {
      setShowInvite(true);
      return;
    }
    setBusy(true);
    try {
      setLinks(await post<InviteLinks>(`/api/sessions/${id}/invites`));
      setShowInvite(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="page session-page">
      <Link className="back-link" to="/sessions">
        <ArrowLeft size={16} />
        All interviews
      </Link>
      <div className="page-heading session-heading">
        <div>
          <div className="session-title">
            <h1>{session.candidateName}</h1>
            <Status state={session.state} />
          </div>
          <p>
            {session.roleTitle}
            <span className="middot">·</span>
            {formatDate(session.createdAt)}
          </p>
        </div>
        <div className="button-row">
          <a
            className="button secondary"
            href={`/api/sessions/${id}/export`}
            download
          >
            <Download size={16} />
            Export
          </a>
          {session.state !== "ended" && (
            <>
              <button
                className="button secondary"
                onClick={invite}
                disabled={busy}
              >
                <UserPlus size={16} />
                Invite devices
              </button>
              <button
                className="button primary"
                onClick={() => setEndConfirm(true)}
              >
                <Square size={14} />
                End interview
              </button>
            </>
          )}
        </div>
      </div>
      <ErrorNotice message={error} />
      <div className="session-strip">
        <span>
          <i className={`live-dot ${connected ? "" : "offline"}`} />
          {connected ? "Workspace connected" : "Reconnecting workspace…"}
        </span>
        <span>
          <Monitor size={15} />
          Laptop{" "}
          {session.present?.includes("laptop")
            ? "connected"
            : "awaiting connection"}
        </span>
        <span>
          <Smartphone size={15} />
          Desk camera{" "}
          {session.present?.includes("phone")
            ? "connected"
            : session.policy.phoneRequired
              ? "required · awaiting connection"
              : "optional"}
        </span>
        <span className="strip-end">
          <Circle
            size={12}
            fill={session.policy.recordingEnabled ? "currentColor" : "none"}
          />
          {session.policy.recordingEnabled
            ? "Recording enabled"
            : "Live viewing only"}
        </span>
      </div>
      <div className="monitor-layout">
        <section className="monitor-column">
          <div className="section-label">
            <span>MONITORING VIEWS</span>
            <button
              className="text-button"
              onClick={() => setPlayback({})}
              disabled={!recordings.some((r) => r.bytes)}
            >
              <Film size={15} />
              Recordings
            </button>
          </div>
          <Feed source="screen" stream={streams.screen} />
          <div className="camera-grid">
            <Feed source="laptop-camera" stream={streams["laptop-camera"]}>
              {streams["laptop-camera"] && (
                <div className="feed-caption" role="status">
                  Face-count checks {visionState}
                </div>
              )}
            </Feed>
            <Feed source="desk-camera" stream={streams["desk-camera"]} />
          </div>
          <div className="system-panel panel">
            <div className="panel-heading">
              <div>
                <h2>
                  <Monitor size={17} />
                  System context
                </h2>
                <p>Reported by the candidate desktop app</p>
              </div>
              <span className={`badge ${telemetry ? "live" : "waiting"}`}>
                {telemetry ? "Available" : "Awaiting desktop app"}
              </span>
            </div>
            {telemetry ? (
              <div className="system-facts">
                <div>
                  <small>CONNECTED DISPLAYS</small>
                  <strong>
                    {telemetry.displays.length} display
                    {telemetry.displays.length === 1 ? "" : "s"}
                  </strong>
                  <span>
                    {telemetry.displays
                      .map((d) => `${d.width} × ${d.height}`)
                      .join(" · ")}
                  </span>
                </div>
                <div>
                  <small>ENVIRONMENT</small>
                  <strong>
                    {telemetry.system.vmIndicators.length
                      ? "Indicators to review"
                      : telemetry.system.error
                        ? "Unavailable"
                        : "System reported"}
                  </strong>
                  <span>{telemetry.system.model || telemetry.platform}</span>
                </div>
                <div>
                  <small>HYPERVISOR</small>
                  <strong>
                    {telemetry.system.hypervisorPresent === undefined
                      ? "Not reported"
                      : telemetry.system.hypervisorPresent
                        ? "Present"
                        : "Not reported present"}
                  </strong>
                  <span>
                    {telemetry.system.virtualizationSecurity
                      ? "Windows virtualization security enabled"
                      : "Presence alone does not establish VM use"}
                  </span>
                </div>
              </div>
            ) : (
              <div className="system-empty">
                <Info size={17} />
                Use the candidate desktop app to collect display and environment
                indicators.
              </div>
            )}
          </div>
          <div className="policy-panel">
            <ShieldCheck size={20} />
            <div>
              <strong>Rules agreed for this interview</strong>
              <p>
                AI assistance{" "}
                {session.policy.aiAllowed ? "allowed" : "not allowed"} ·
                Additional displays{" "}
                {session.policy.extraDisplaysAllowed
                  ? "allowed"
                  : "not allowed"}{" "}
                · Data deleted {formatDate(session.expiresAt)}
              </p>
            </div>
          </div>
        </section>
        <aside className="timeline panel">
          <div className="panel-heading">
            <div>
              <h2>Evidence timeline</h2>
              <p>Every observation, with context.</p>
            </div>
            <span className="count-badge">{events.length}</span>
          </div>
          <div className="timeline-summary">
            <Activity size={17} />
            <strong>{unreviewed}</strong> observation
            {unreviewed === 1 ? "" : "s"} awaiting review
          </div>
          <div className="tabs timeline-tabs">
            {["all", "review", "technical"].map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={filter === f ? "active" : ""}
              >
                {f === "all"
                  ? "All events"
                  : f === "review"
                    ? "To review"
                    : "Technical"}
              </button>
            ))}
          </div>
          <div className="timeline-events">
            {filtered.map((e) => (
              <button
                key={e.id}
                className={`event-card ${e.level}`}
                onClick={() => setSelectedEvent(e)}
              >
                <div className="event-meta">
                  <span>
                    <Clock size={11} />
                    {formatTime(e.at)}
                  </span>
                  <span
                    className={`event-level ${e.reviewStatus === "dismissed" ? "muted" : ""}`}
                  >
                    {e.reviewStatus === "dismissed"
                      ? "Dismissed"
                      : e.reviewStatus === "acknowledged"
                        ? "Reviewed"
                        : e.level === "review"
                          ? "Review"
                          : e.level === "technical"
                            ? "Technical"
                            : "Info"}
                  </span>
                </div>
                <strong>{e.title}</strong>
                <p>{e.detail}</p>
                <span className="event-link">
                  View context
                  <ChevronRight size={13} />
                </span>
              </button>
            ))}
            {!filtered.length && (
              <div className="timeline-empty">
                <Activity size={22} />
                <p>No observations in this view.</p>
              </div>
            )}
          </div>
          <div className="timeline-footer">
            <button
              className="button secondary"
              onClick={() => setBookmark(true)}
              disabled={session.state === "ended"}
            >
              <Bookmark size={15} />
              Add a bookmark
            </button>
            <small>
              Observations support review.
              <br />
              They do not establish cheating.
            </small>
          </div>
        </aside>
      </div>
      <div className="session-bottom">
        <span>
          <LockIcon />
          Private session · Recording is available while a reviewer is
          connected.
        </span>
        <button
          className="text-button danger"
          onClick={() => setDeleteConfirm(true)}
        >
          <Trash2 size={14} />
          Delete session
        </button>
      </div>
      {showInvite && links && (
        <Modal
          title="Connect interview devices"
          onClose={() => setShowInvite(false)}
        >
          <p className="muted">
            Invite links expire after 24 hours or when the interview ends. Open
            the laptop link in the Clearview desktop app.
          </p>
          <div className="invite-row">
            <span className="card-icon">
              <Monitor size={22} />
            </span>
            <div>
              <h3>Candidate laptop</h3>
              <input
                readOnly
                value={links.candidateUrl}
                aria-label="Candidate invite URL"
              />
              <div className="invite-buttons">
                <CopyButton value={links.candidateUrl} />
                <a
                  className="text-button"
                  href={links.candidateUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open setup
                  <ChevronRight size={14} />
                </a>
              </div>
            </div>
          </div>
          <div className="phone-pair">
            <QRCodeSVG value={links.phoneUrl} size={150} marginSize={2} />
            <div>
              <h3>Phone desk camera</h3>
              <p>
                Scan with the phone. Position it to show hands, keyboard, and
                the physical laptop screen.
              </p>
              <CopyButton value={links.phoneUrl} label="Copy phone link" />
              <input
                className="phone-url"
                readOnly
                value={links.phoneUrl}
                aria-label="Phone invite URL"
              />
            </div>
          </div>
          <div className="notice">
            <Info size={16} />
            Phone camera access requires HTTPS with a trusted certificate. For a
            local pilot, connect devices to the same Wi-Fi.
          </div>
        </Modal>
      )}
      {selectedEvent && (
        <EventReview
          event={selectedEvent}
          sessionId={id!}
          hasRecording={recordings.some((r) => r.bytes)}
          onClose={() => setSelectedEvent(null)}
          onPlay={() => {
            setPlayback({ at: selectedEvent.at });
            setSelectedEvent(null);
          }}
          onSave={load}
        />
      )}
      {playback && (
        <Playback
          recordings={recordings}
          at={playback.at}
          onClose={() => setPlayback(null)}
        />
      )}
      {endConfirm && (
        <Modal title="End this interview?" onClose={() => setEndConfirm(false)}>
          <p>
            Camera and screen sharing will stop. Invite links will be revoked.
            Evidence remains available until {formatDate(session.expiresAt)}.
          </p>
          <div className="modal-actions">
            <button
              className="button secondary"
              onClick={() => setEndConfirm(false)}
            >
              Keep monitoring
            </button>
            <button
              className="button primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await post(`/api/sessions/${id}/end`);
                  setEndConfirm(false);
                  await load();
                } catch (err) {
                  setError((err as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              End interview
            </button>
          </div>
        </Modal>
      )}
      {deleteConfirm && (
        <Modal
          title="Delete session and evidence?"
          onClose={() => setDeleteConfirm(false)}
        >
          <p>
            This permanently removes {session.candidateName}’s session,
            observations, and recordings from this server.
          </p>
          <div className="modal-actions">
            <button
              className="button secondary"
              onClick={() => setDeleteConfirm(false)}
            >
              Cancel
            </button>
            <button
              className="button danger-button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api(`/api/sessions/${id}`, { method: "DELETE" });
                  navigate("/sessions");
                } catch (err) {
                  setError((err as Error).message);
                  setBusy(false);
                }
              }}
            >
              Delete permanently
            </button>
          </div>
        </Modal>
      )}
      {bookmark && (
        <Modal title="Bookmark a moment" onClose={() => setBookmark(false)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await post(`/api/sessions/${id}/events`, {
                  kind: "bookmark",
                  detail: note,
                });
                setBookmark(false);
                setNote("");
              } catch (err) {
                setError((err as Error).message);
              }
            }}
          >
            <label>
              What did you observe?
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={1000}
                required
                placeholder="Describe an observable event and the context to review."
              />
            </label>
            <div className="modal-actions">
              <button className="button primary">
                Save bookmark
                <Bookmark size={15} />
              </button>
            </div>
          </form>
        </Modal>
      )}
    </main>
  );
}
function LockIcon() {
  return <ShieldCheck size={14} />;
}
function EventReview({
  event,
  sessionId,
  onClose,
  onSave,
  onPlay,
  hasRecording,
}: {
  event: EvidenceEvent;
  sessionId: string;
  onClose: () => void;
  onSave: () => void;
  onPlay: () => void;
  hasRecording: boolean;
}) {
  const [status, setStatus] = useState(event.reviewStatus),
    [note, setNote] = useState(event.note),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <Modal title="Review observation" onClose={onClose}>
      <div className="observation-heading">
        <span className={`badge ${event.level}`}>{event.level}</span>
        <span className="muted">{formatTime(event.at)}</span>
      </div>
      <h3>{event.title}</h3>
      <p>{event.detail}</p>
      {Object.keys(event.data).length > 0 && (
        <details className="raw-details">
          <summary>Observation data</summary>
          <pre>{JSON.stringify(event.data, null, 2)}</pre>
        </details>
      )}
      <div className="notice">
        <Info size={16} />
        Consider the interview rules and surrounding evidence. An observation
        does not establish cheating.
      </div>
      {hasRecording && (
        <button className="button secondary" onClick={onPlay}>
          <Play size={15} />
          View recordings at this time
        </button>
      )}
      <form
        className="review-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api(`/api/sessions/${sessionId}/events/${event.id}`, {
              method: "PATCH",
              body: JSON.stringify({ reviewStatus: status, note }),
            });
            onSave();
            onClose();
          } catch (err) {
            setError((err as Error).message);
            setBusy(false);
          }
        }}
      >
        <label>
          Review status
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as typeof status)}
          >
            <option value="unreviewed">Needs review</option>
            <option value="acknowledged">Reviewed</option>
            <option value="dismissed">Dismissed with context</option>
          </select>
        </label>
        <label>
          Reviewer note
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={1000}
            placeholder="Add context or explain your review decision."
          />
        </label>
        <ErrorNotice message={error} />
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            <Check size={15} />
            Save review
          </button>
        </div>
      </form>
    </Modal>
  );
}
function Playback({
  recordings,
  at,
  onClose,
}: {
  recordings: Recording[];
  at?: string;
  onClose: () => void;
}) {
  const available = recordings.filter((r) => r.bytes > 0);
  const selected = at
    ? ((["screen", "laptop-camera", "desk-camera"] as Source[])
        .map((source) =>
          available
            .filter(
              (r) =>
                r.source === source &&
                Date.parse(r.startedAt) <= Date.parse(at) &&
                (!r.endedAt || Date.parse(r.endedAt) >= Date.parse(at)),
            )
            .at(-1),
        )
        .filter(Boolean) as Recording[])
    : available;
  return (
    <Modal
      title={at ? `Evidence around ${formatTime(at)}` : "Session recordings"}
      onClose={onClose}
      wide
    >
      <p className="muted">
        {at
          ? "Each recording seeks to the selected observation time. Capture and network latency can affect alignment."
          : "Recordings are created while this workspace is connected. Gaps remain visible as separate recordings."}
      </p>
      {!selected.length && (
        <div className="empty-state">
          <Film size={26} />
          <h3>No recording covers this timestamp</h3>
          <p>
            The reviewer may have been disconnected, or recording had not
            started.
          </p>
        </div>
      )}
      <div className="playback-grid">
        {selected.map((r) => (
          <div className="recording-card" key={r.id}>
            <div>
              <strong>{sourceName[r.source]}</strong>
              <small>
                {formatTime(r.startedAt)} · {(r.bytes / 1024 / 1024).toFixed(1)}{" "}
                MB · {r.endedAt ? "Finished" : "Recording"}
              </small>
            </div>
            <video
              controls
              playsInline
              preload="metadata"
              src={`/api/recordings/${r.id}/media`}
              onLoadedMetadata={(e) => {
                if (at)
                  e.currentTarget.currentTime = Math.max(
                    0,
                    (Date.parse(at) - Date.parse(r.startedAt)) / 1000,
                  );
              }}
            />
            <a
              href={`/api/recordings/${r.id}/media`}
              download={`clearview-${r.source}-${r.id}.${r.mimeType.includes("mp4") ? "mp4" : "webm"}`}
              className="text-button"
            >
              <Download size={14} />
              Download recording
            </a>
            {r.sha256 && <small className="hash">SHA-256: {r.sha256}</small>}
          </div>
        ))}
      </div>
    </Modal>
  );
}
