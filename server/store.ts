import { DatabaseSync } from "node:sqlite";
import {
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
  createHash,
  createHmac,
} from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type {
  InterviewSession,
  EvidenceEvent,
  Policy,
  Recording,
  Role,
  DesktopTelemetry,
} from "../shared/types.js";

export const digest = (s: string) =>
  createHash("sha256").update(s).digest("hex");
export const token = () => randomBytes(32).toString("base64url");
type Row = Record<string, any>;
export class Store {
  db: DatabaseSync;
  constructor(
    public directory: string,
    adminPassword?: string,
  ) {
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(join(directory, "clearview.sqlite"));
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS auth (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, candidateName TEXT NOT NULL, roleTitle TEXT NOT NULL,
        state TEXT NOT NULL, createdAt TEXT NOT NULL, startedAt TEXT, endedAt TEXT,
        expiresAt TEXT NOT NULL, policy TEXT NOT NULL, telemetry TEXT);
      CREATE TABLE IF NOT EXISTS invites (
        hash TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL, expires INTEGER NOT NULL, consentAt TEXT);
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        at TEXT NOT NULL, kind TEXT NOT NULL, level TEXT NOT NULL, actor TEXT NOT NULL,
        title TEXT NOT NULL, detail TEXT NOT NULL, data TEXT NOT NULL,
        reviewStatus TEXT NOT NULL DEFAULT 'unreviewed', note TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS events_session ON events(sessionId, at);
      CREATE TABLE IF NOT EXISTS recordings (
        id TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        source TEXT NOT NULL, startedAt TEXT NOT NULL, endedAt TEXT, mimeType TEXT NOT NULL,
        bytes INTEGER NOT NULL DEFAULT 0, nextSeq INTEGER NOT NULL DEFAULT 0,
        lastHash TEXT, sha256 TEXT);`);
    if (
      !this.db.prepare("SELECT value FROM settings WHERE key=?").get("password")
    ) {
      const passwordFile = join(directory, "admin-password");
      const password =
        adminPassword ||
        (existsSync(passwordFile)
          ? readFileSync(passwordFile, "utf8").trim()
          : token());
      if (!adminPassword && !existsSync(passwordFile))
        writeFileSync(passwordFile, password, { mode: 0o600 });
      const salt = randomBytes(16).toString("hex");
      this.db
        .prepare("INSERT INTO settings VALUES (?,?)")
        .run(
          "password",
          `${salt}:${scryptSync(password, salt, 64).toString("hex")}`,
        );
    }
    if (
      !this.db
        .prepare("SELECT value FROM settings WHERE key=?")
        .get("pairing-key")
    )
      this.db
        .prepare("INSERT INTO settings VALUES (?,?)")
        .run("pairing-key", token());
    // A process restart leaves gaps visible instead of continuing incomplete recording files.
    this.db
      .prepare("UPDATE recordings SET endedAt=? WHERE endedAt IS NULL")
      .run(new Date().toISOString());
  }
  checkPassword(password: string) {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key=?")
      .get("password") as Row;
    const [salt, stored] = row.value.split(":");
    return timingSafeEqual(
      scryptSync(password, salt, 64),
      Buffer.from(stored, "hex"),
    );
  }
  authorize(cookie: string | undefined) {
    const value = cookie
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith("cv_auth="))
      ?.slice(8);
    if (!value) return false;
    return Boolean(
      this.db
        .prepare("SELECT hash FROM auth WHERE hash=? AND expires>?")
        .get(digest(value), Date.now()),
    );
  }
  login() {
    const raw = token();
    this.db.prepare("DELETE FROM auth WHERE expires<?").run(Date.now());
    this.db
      .prepare("INSERT INTO auth VALUES (?,?)")
      .run(digest(raw), Date.now() + 12 * 60 * 60 * 1000);
    return raw;
  }
  logout(cookie?: string) {
    const raw = cookie
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith("cv_auth="))
      ?.slice(8);
    if (raw) this.db.prepare("DELETE FROM auth WHERE hash=?").run(digest(raw));
  }
  getSession(id: string): InterviewSession | undefined {
    const r = this.db.prepare("SELECT * FROM sessions WHERE id=?").get(id) as
      Row | undefined;
    if (!r) return;
    const { telemetry: _, ...rest } = r;
    return { ...rest, policy: JSON.parse(r.policy) } as InterviewSession;
  }
  list(): InterviewSession[] {
    return (
      this.db
        .prepare(
          `SELECT s.*, (SELECT COUNT(*) FROM events e WHERE e.sessionId=s.id) eventCount,
      (SELECT COUNT(*) FROM events e WHERE e.sessionId=s.id AND level='review' AND reviewStatus='unreviewed') reviewCount
      FROM sessions s ORDER BY createdAt DESC`,
        )
        .all() as Row[]
    ).map((r) => {
      const { telemetry: _, ...rest } = r;
      return { ...rest, policy: JSON.parse(r.policy) } as InterviewSession;
    });
  }
  create(candidateName: string, roleTitle: string, policy: Policy) {
    const now = new Date();
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO sessions(id,candidateName,roleTitle,state,createdAt,expiresAt,policy) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        id,
        candidateName,
        roleTitle,
        "waiting",
        now.toISOString(),
        new Date(now.getTime() + policy.retentionDays * 86400000).toISOString(),
        JSON.stringify(policy),
      );
    this.event(
      id,
      "session_created",
      "info",
      "system",
      "Session created",
      "Monitoring rules and retention period set.",
    );
    return this.getSession(id)!;
  }
  makeInvite(id: string, role: "laptop" | "phone", suppliedToken?: string) {
    this.db
      .prepare("DELETE FROM invites WHERE sessionId=? AND role=?")
      .run(id, role);
    const raw = suppliedToken || token();
    const expires = Math.min(
      Date.now() + 24 * 60 * 60 * 1000,
      Date.parse(this.getSession(id)!.expiresAt),
    );
    this.db
      .prepare(
        "INSERT INTO invites(hash,sessionId,role,expires) VALUES (?,?,?,?)",
      )
      .run(digest(raw), id, role, expires);
    return raw;
  }
  phoneInvite(laptopToken: string) {
    const laptop = this.invite(laptopToken);
    if (!laptop || laptop.role !== "laptop")
      throw new Error("A valid laptop invitation is required.");
    const key = (
      this.db
        .prepare("SELECT value FROM settings WHERE key=?")
        .get("pairing-key") as Row
    ).value;
    const raw = createHmac("sha256", key)
      .update(`desk-camera:${laptopToken}`)
      .digest("base64url");
    if (!this.invite(raw)) this.makeInvite(laptop.session.id, "phone", raw);
    return raw;
  }
  invite(
    raw: string,
  ):
    | {
        session: InterviewSession;
        role: "laptop" | "phone";
        consentAt: string | null;
      }
    | undefined {
    const row = this.db
      .prepare("SELECT * FROM invites WHERE hash=? AND expires>?")
      .get(digest(raw), Date.now()) as Row | undefined;
    if (!row) return;
    const session = this.getSession(row.sessionId);
    if (
      !session ||
      session.state === "ended" ||
      Date.parse(session.expiresAt) <= Date.now()
    )
      return;
    return { session, role: row.role, consentAt: row.consentAt };
  }
  consent(raw: string) {
    this.db
      .prepare("UPDATE invites SET consentAt=? WHERE hash=?")
      .run(new Date().toISOString(), digest(raw));
  }
  event(
    sessionId: string,
    kind: string,
    level: EvidenceEvent["level"],
    actor: Role | "system",
    title: string,
    detail: string,
    data: Record<string, unknown> = {},
  ): EvidenceEvent {
    const e: EvidenceEvent = {
      id: randomUUID(),
      sessionId,
      at: new Date().toISOString(),
      kind,
      level,
      actor,
      title,
      detail,
      data,
      reviewStatus: "unreviewed",
      note: "",
    };
    this.db
      .prepare(
        "INSERT INTO events(id,sessionId,at,kind,level,actor,title,detail,data) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(
        e.id,
        sessionId,
        e.at,
        kind,
        level,
        actor,
        title,
        detail,
        JSON.stringify(data),
      );
    return e;
  }
  events(id: string): EvidenceEvent[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM events WHERE sessionId=? ORDER BY at DESC,rowid DESC",
        )
        .all(id) as Row[]
    ).map((r) => ({ ...r, data: JSON.parse(r.data) }) as EvidenceEvent);
  }
  telemetry(id: string): DesktopTelemetry | null {
    const r = this.db
      .prepare("SELECT telemetry FROM sessions WHERE id=?")
      .get(id) as Row;
    return r?.telemetry ? JSON.parse(r.telemetry) : null;
  }
  recordings(id: string): Recording[] {
    return this.db
      .prepare(
        "SELECT id,sessionId,source,startedAt,endedAt,mimeType,bytes,sha256 FROM recordings WHERE sessionId=? ORDER BY startedAt",
      )
      .all(id) as unknown as Recording[];
  }
  close() {
    this.db.close();
  }
}
