import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  Routes,
  Route,
  NavLink,
  Link,
  useNavigate,
  useLocation,
} from "react-router-dom";
import {
  ArrowUpRight,
  Plus,
  ShieldCheck,
  LayoutDashboard,
  CalendarClock,
  Settings,
  LogOut,
  Activity,
  ChevronRight,
  Radio,
  LockKeyhole,
  ArrowRight,
  CheckCheck,
  Monitor,
  Smartphone,
  Camera,
  Download,
  ExternalLink,
} from "lucide-react";
import type { InterviewSession, Policy, AppConfig } from "../shared/types";
import { api, post, formatDate } from "./api";
import { Brand, Modal, ErrorNotice } from "./components";
import { SessionPage } from "./Session";
import { CandidatePage, DesktopWelcome } from "./Candidate";

export type InviteLinks = { candidateUrl: string; phoneUrl: string };
const defaultPolicy: Policy = {
  aiAllowed: false,
  extraDisplaysAllowed: false,
  phoneRequired: true,
  recordingEnabled: true,
  retentionDays: 7,
};

export function App() {
  const location = useLocation();
  const participant = /^\/(join|phone|desktop)(\/|$)/.test(location.pathname);
  const [authenticated, setAuthenticated] = useState<boolean | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    if (!participant)
      api<{ authenticated: boolean }>("/api/auth")
        .then((r) => setAuthenticated(r.authenticated))
        .catch((e) => setError(e.message));
  }, [participant]);
  if (participant)
    return (
      <Routes>
        <Route path="/join/:token" element={<CandidatePage role="laptop" />} />
        <Route path="/phone/:token" element={<CandidatePage role="phone" />} />
        <Route path="/desktop" element={<DesktopWelcome />} />
      </Routes>
    );
  if (!authenticated)
    return (
      <Login
        loading={authenticated === null}
        error={error}
        onLogin={() => setAuthenticated(true)}
      />
    );
  return (
    <Shell
      onLogout={async () => {
        await post("/api/auth/logout");
        setAuthenticated(false);
      }}
    >
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/sessions" element={<Dashboard all />} />
        <Route path="/sessions/:id" element={<SessionPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route
          path="*"
          element={
            <div className="page">
              <h1>Page not found</h1>
              <Link to="/">Back to overview</Link>
            </div>
          }
        />
      </Routes>
    </Shell>
  );
}
function Login({
  loading,
  error: initialError,
  onLogin,
}: {
  loading: boolean;
  error: string;
  onLogin: () => void;
}) {
  const [password, setPassword] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await post("/api/auth/login", { password });
      onLogin();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login">
      <div className="login-story">
        <Brand light />
        <div className="login-copy">
          <span className="eyebrow mint">
            INTERVIEW INTEGRITY, WITH CLARITY
          </span>
          <h1>
            Confidence starts
            <br />
            with a clearer view.
          </h1>
          <p>
            Bring camera, screen, and system evidence together. Give every
            interview the context it deserves.
          </p>
          <div className="story-points">
            <span>
              <CheckCheck size={18} />
              Clear evidence for human review
            </span>
            <span>
              <LockKeyhole size={18} />
              Private, consent-based monitoring
            </span>
            <span>
              <Smartphone size={18} />
              Two perspectives. One timeline.
            </span>
          </div>
        </div>
        <div className="login-footer">Built for thoughtful hiring teams.</div>
        <div className="orb orb-one" />
        <div className="orb orb-two" />
      </div>
      <div className="login-form">
        <div className="mobile-brand">
          <Brand />
        </div>
        <span className="eyebrow">YOUR REVIEW WORKSPACE</span>
        <h2>Welcome to Clearview</h2>
        <p>Sign in to manage interviews and review evidence.</p>
        <form onSubmit={submit}>
          <label>
            Reviewer password
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              placeholder="Enter your workspace password"
            />
          </label>
          <ErrorNotice message={error || initialError} />
          <button className="button primary" disabled={busy || loading}>
            {busy
              ? "Signing in…"
              : loading && !initialError
                ? "Connecting…"
                : "Open workspace"}
            <ArrowRight size={18} />
          </button>
        </form>
        <div className="setup-hint">
          <LockKeyhole size={17} />
          <p>
            First time here? Your password is set with{" "}
            <code>ADMIN_PASSWORD</code> or saved in{" "}
            <code>.data/admin-password</code> on the server.
          </p>
        </div>
        <small className="login-version">CLEARVIEW / LOCAL PILOT · V0.1</small>
      </div>
    </div>
  );
}
function Shell({
  children,
  onLogout,
}: {
  children: ReactNode;
  onLogout: () => Promise<void>;
}) {
  const [error, setError] = useState("");
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand light />
        <div className="workspace-label">
          <span className="workspace-mark">W</span>
          <div>
            Interview workspace<small>Local pilot</small>
          </div>
          <span className="beta">BETA</span>
        </div>
        <nav>
          <NavLink to="/" end>
            <LayoutDashboard size={18} />
            Overview
          </NavLink>
          <NavLink to="/sessions">
            <CalendarClock size={18} />
            Interviews
          </NavLink>
          <NavLink to="/settings">
            <Settings size={18} />
            Workspace settings
          </NavLink>
        </nav>
        <div className="sidebar-note">
          <ShieldCheck size={24} />
          <strong>Evidence with context.</strong>
          <p>
            Observations support your judgment. Every decision stays with you.
          </p>
        </div>
        <div className="sidebar-footer">
          <span className="avatar">R</span>
          <div>
            Reviewer<small>Workspace administrator</small>
          </div>
          <button
            className="icon-button"
            aria-label="Sign out"
            onClick={() => {
              onLogout().catch((e) => setError(e.message));
            }}
          >
            <LogOut size={17} />
          </button>
        </div>
        {error && <p className="error-text">{error}</p>}
      </aside>
      <div className="app-content">
        <header className="topbar">
          <div>
            <span className="topbar-dot" />
            Interview integrity workspace
          </div>
          <span className="topbar-right">
            <LockKeyhole size={14} />
            Private workspace<span className="avatar tiny">R</span>
          </span>
        </header>
        {children}
      </div>
    </div>
  );
}
function Dashboard({ all = false }: { all?: boolean }) {
  const [sessions, setSessions] = useState<InterviewSession[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [create, setCreate] = useState(false),
    [filter, setFilter] = useState("all"),
    [query, setQuery] = useState("");
  useEffect(() => {
    const load = () =>
      api<InterviewSession[]>("/api/sessions")
        .then((r) => {
          setSessions(r);
          setError("");
        })
        .catch((e) => setError(e.message))
        .finally(() => setLoading(false));
    void load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);
  const live = sessions.filter((s) => s.state === "live").length,
    review = sessions.reduce((n, s) => n + (s.reviewCount || 0), 0);
  const filtered = sessions.filter(
    (s) =>
      (filter === "all" || s.state === filter) &&
      `${s.candidateName} ${s.roleTitle}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <main className="page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">YOUR WORKSPACE</span>
          <h1>{all ? "Interviews" : "Overview"}</h1>
          <p>
            {all
              ? "All your sessions, with the context you need."
              : "A clear view of your interviews and what needs attention."}
          </p>
        </div>
        <button className="button primary" onClick={() => setCreate(true)}>
          <Plus size={18} />
          New interview
        </button>
      </div>
      {!all && (
        <div className="hero">
          <div>
            <span className="hero-tag">
              <ShieldCheck size={14} />
              BUILT FOR TRUST
            </span>
            <h2>
              Every interview.
              <br />
              <span>A clearer picture.</span>
            </h2>
            <p>
              Bring the whole session into view.
              <br />
              Review meaningful moments, with evidence.
            </p>
            <button className="text-button" onClick={() => setCreate(true)}>
              Start your next interview
              <ArrowUpRight size={17} />
            </button>
          </div>
          <div className="hero-graphic" aria-hidden="true">
            <div className="radar-ring ring-one" />
            <div className="radar-ring ring-two" />
            <div className="radar-ring ring-three" />
            <div className="radar-center">
              <ShieldCheck size={46} strokeWidth={1.4} />
            </div>
            <div className="floating-signal signal-camera">
              <Camera size={20} />
              <span>
                Camera view
                <i />
              </span>
            </div>
            <div className="floating-signal signal-screen">
              <Monitor size={20} />
              <span>
                Screen evidence
                <i />
              </span>
            </div>
            <div className="floating-signal signal-phone">
              <Smartphone size={20} />
              <span>
                Desk perspective
                <i />
              </span>
            </div>
          </div>
        </div>
      )}
      <div className="stats">
        <Stat
          label="Total interviews"
          value={sessions.length}
          icon={<CalendarClock size={20} />}
          detail="Across your workspace"
        />
        <Stat
          label="Live sessions"
          value={live}
          icon={<Radio size={20} />}
          detail="Monitoring in progress"
          mint
        />
        <Stat
          label="Awaiting review"
          value={review}
          icon={<Activity size={20} />}
          detail="Observations needing context"
        />
        <Stat
          label="Completed"
          value={sessions.filter((s) => s.state === "ended").length}
          icon={<CheckCheck size={20} />}
          detail="Ready for evidence review"
        />
      </div>
      <ErrorNotice message={error} />
      <section className="panel interviews-panel">
        <div className="panel-heading">
          <div>
            <h2>{all ? "All interviews" : "Recent interviews"}</h2>
            <p>
              A session is more than a flag. Open it to see the full context.
            </p>
          </div>
          {!all && (
            <Link to="/sessions" className="text-button">
              View all
              <ArrowUpRight size={16} />
            </Link>
          )}
        </div>
        <div className="table-toolbar">
          <div className="tabs">
            {["all", "live", "waiting", "ended"].map((v) => (
              <button
                key={v}
                onClick={() => setFilter(v)}
                className={filter === v ? "active" : ""}
              >
                {v === "all"
                  ? "All sessions"
                  : v === "ended"
                    ? "Completed"
                    : v[0].toUpperCase() + v.slice(1)}
              </button>
            ))}
          </div>
          <input
            aria-label="Search interviews"
            className="search"
            placeholder="Search candidate or role…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {loading ? (
          <div className="empty-state">Loading interviews…</div>
        ) : !filtered.length ? (
          <div className="empty-state">
            <div className="empty-illustration">
              <CalendarClock size={30} strokeWidth={1.3} />
              <span>
                <ShieldCheck size={15} />
              </span>
            </div>
            <h3>
              {sessions.length
                ? "No matching interviews"
                : "Your next interview starts here"}
            </h3>
            <p>
              {sessions.length
                ? "Try a different search or session filter."
                : "Create a session, invite a candidate, and bring the evidence into one view."}
            </p>
            {!sessions.length && (
              <button
                className="button secondary"
                onClick={() => setCreate(true)}
              >
                <Plus size={16} />
                Create your first interview
              </button>
            )}
          </div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Candidate</th>
                  <th>Status</th>
                  <th>Connections</th>
                  <th>Review</th>
                  <th>Created</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filtered.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <Link className="candidate-cell" to={`/sessions/${s.id}`}>
                        <span className="avatar candidate-avatar">
                          {s.candidateName
                            .split(" ")
                            .map((v) => v[0])
                            .slice(0, 2)
                            .join("")
                            .toUpperCase()}
                        </span>
                        <span>
                          <strong>{s.candidateName}</strong>
                          <small>{s.roleTitle}</small>
                        </span>
                      </Link>
                    </td>
                    <td>
                      <Status state={s.state} />
                    </td>
                    <td>
                      <div className="connection-icons">
                        <Monitor
                          size={17}
                          className={
                            s.present?.includes("laptop") ? "online" : ""
                          }
                        />
                        <Smartphone
                          size={17}
                          className={
                            s.present?.includes("phone") ? "online" : ""
                          }
                        />
                      </div>
                    </td>
                    <td>
                      {s.reviewCount ? (
                        <span className="badge review">
                          {s.reviewCount} to review
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="muted">{formatDate(s.createdAt)}</td>
                    <td>
                      <Link
                        className="icon-button"
                        to={`/sessions/${s.id}`}
                        aria-label={`Open ${s.candidateName} interview`}
                      >
                        <ChevronRight size={18} />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <div className="page-footnote">
        <ShieldCheck size={14} />
        Clearview records observations for human review. It does not make hiring
        decisions.
      </div>
      {create && <CreateInterview onClose={() => setCreate(false)} />}
    </main>
  );
}
function Stat({
  label,
  value,
  detail,
  icon,
  mint = false,
}: {
  label: string;
  value: number;
  detail: string;
  icon: ReactNode;
  mint?: boolean;
}) {
  return (
    <div className="stat">
      <div className="stat-label">
        {label}
        <span className={mint ? "mint-icon" : ""}>{icon}</span>
      </div>
      <strong>{value.toString().padStart(2, "0")}</strong>
      <small>
        {mint && <i className="live-dot" />}
        {detail}
      </small>
    </div>
  );
}
export function Status({ state }: { state: InterviewSession["state"] }) {
  return (
    <span className={`badge ${state}`}>
      <i />
      {state === "ended" ? "Completed" : state === "live" ? "Live" : "Waiting"}
    </span>
  );
}
function CreateInterview({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [candidateName, setName] = useState(""),
    [roleTitle, setRole] = useState(""),
    [policy, setPolicy] = useState(defaultPolicy),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const set = (key: keyof Policy, value: boolean | number) =>
    setPolicy((p) => ({ ...p, [key]: value }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const result = await post<{
        session: InterviewSession;
        links: InviteLinks;
      }>("/api/sessions", { candidateName, roleTitle, policy });
      navigate(`/sessions/${result.session.id}`, {
        state: { links: result.links },
      });
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title="Create an interview" onClose={onClose}>
      <form onSubmit={submit} className="form">
        <p className="muted">
          Set expectations before the session. Candidates see these rules and
          accept monitoring before joining.
        </p>
        <div className="form-row">
          <label>
            Candidate name
            <input
              value={candidateName}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
              required
              placeholder="e.g. Alex Morgan"
            />
          </label>
          <label>
            Interview role
            <input
              value={roleTitle}
              onChange={(e) => setRole(e.target.value)}
              maxLength={120}
              required
              placeholder="e.g. Frontend engineer"
            />
          </label>
        </div>
        <div className="form-divider">Session rules</div>
        <Toggle
          label="Allow AI assistance"
          detail="Use of an AI assistant is permitted for this interview."
          checked={policy.aiAllowed}
          onChange={(v) => set("aiAllowed", v)}
        />
        <Toggle
          label="Allow additional displays"
          detail="Multiple OS-reported screens are permitted."
          checked={policy.extraDisplaysAllowed}
          onChange={(v) => set("extraDisplaysAllowed", v)}
        />
        <Toggle
          label="Require a phone desk camera"
          detail="Show hands, keyboard, and the physical laptop screen."
          checked={policy.phoneRequired}
          onChange={(v) => set("phoneRequired", v)}
        />
        <Toggle
          label="Record monitoring feeds"
          detail="A connected reviewer records camera and screen feeds. Live viewing works without recording."
          checked={policy.recordingEnabled}
          onChange={(v) => set("recordingEnabled", v)}
        />
        <label className="retention-label">
          Delete session data after
          <select
            value={policy.retentionDays}
            onChange={(e) => set("retentionDays", Number(e.target.value))}
          >
            <option value={1}>1 day</option>
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
          </select>
        </label>
        <ErrorNotice message={error} />
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? "Creating…" : "Create interview"}
            <ArrowRight size={16} />
          </button>
        </div>
      </form>
    </Modal>
  );
}
export function Toggle({
  label,
  detail,
  checked,
  onChange,
}: {
  label: string;
  detail: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="toggle-row">
      <span>
        <strong>{label}</strong>
        <small>{detail}</small>
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="toggle-track" />
    </label>
  );
}
function SettingsPage() {
  const [config, setConfig] = useState<AppConfig>(),
    [error, setError] = useState("");
  useEffect(() => {
    api<AppConfig>("/api/config")
      .then(setConfig)
      .catch((e) => setError(e.message));
  }, []);
  return (
    <main className="page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">WORKSPACE</span>
          <h1>Settings & setup</h1>
          <p>Connect your devices and understand what this pilot collects.</p>
        </div>
      </div>
      <ErrorNotice message={error} />
      <div className="settings-grid">
        <section className="panel settings-card">
          <span className="card-icon">
            <Monitor size={24} />
          </span>
          <h2>Candidate desktop app</h2>
          <p>
            The desktop app shares OS-reported display information and Windows
            environment indicators. Capture begins after the candidate accepts
            the rules.
          </p>
          <div className="command">npm run desktop</div>
          <p className="small-text">
            Set <code>CLEARVIEW_SERVER_URL</code> to your server address when
            running on another computer. Paste the candidate invite into the
            desktop app.
          </p>
          <a href="/desktop" className="button secondary">
            <ExternalLink size={16} />
            Open candidate setup
          </a>
        </section>
        <section className="panel settings-card">
          <span className="card-icon">
            <Smartphone size={24} />
          </span>
          <h2>Phone & network</h2>
          <p>
            Use the same Wi-Fi for a local pilot. Pair through the session QR
            code and position the phone beside the laptop.
          </p>
          <label>
            Public pairing address
            <input readOnly value={config?.publicBaseUrl || "Loading…"} />
          </label>
          <p className="small-text">
            Phone camera access requires HTTPS and a trusted certificate.
            Install the local certificate for testing, or configure a trusted
            certificate and TURN service for remote sessions.
          </p>
        </section>
        <section className="panel settings-card">
          <span className="card-icon">
            <LockKeyhole size={24} />
          </span>
          <h2>Recording & privacy</h2>
          <p>
            Each interview sets its own recording policy and retention period.
            Access requires reviewer sign-in; invite links grant access only to
            the assigned participant role.
          </p>
          <ul className="plain-list">
            <li>Retention: 1, 7, or 30 days from creation</li>
            <li>Face-count detection runs locally in the reviewer browser</li>
            <li>No emotion, dishonesty, or employability scoring</li>
            <li>No microphone recording or global keystroke logging</li>
          </ul>
        </section>
        <section className="panel settings-card">
          <span className="card-icon">
            <Download size={24} />
          </span>
          <h2>Pilot boundaries</h2>
          <p>
            This version provides live monitoring and evidence review. It is
            designed for one organization with a shared reviewer account.
          </p>
          <ul className="plain-list">
            <li>System indicators are candidate-reported telemetry</li>
            <li>Desk cameras provide visual evidence of devices</li>
            <li>Missing feeds are reported as technical issues</li>
            <li>JSON exports include observations and recording hashes</li>
          </ul>
          <p className="small-text">
            Version {config?.version || "0.1.0"} · See the project README for
            deployment and test instructions.
          </p>
        </section>
      </div>
    </main>
  );
}
