import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { rateLimit } from "express-rate-limit";
import { Server } from "socket.io";
import { z } from "zod";
import { randomUUID, createHash } from "node:crypto";
import { appendFile, mkdir, rm, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { Server as HttpServer } from "node:http";
import type { Server as HttpsServer } from "node:https";
import { Store } from "./store.js";
import { participantEvents, reviewerEvents } from "../shared/events.js";
import type { Role, DesktopTelemetry, Recording } from "../shared/types.js";

const policySchema = z.object({
  aiAllowed: z.boolean(),
  extraDisplaysAllowed: z.boolean(),
  phoneRequired: z.boolean(),
  recordingEnabled: z.boolean(),
  retentionDays: z.union([z.literal(1), z.literal(7), z.literal(30)]),
});
const telemetrySchema = z.object({
  platform: z.string().max(40),
  displays: z
    .array(
      z.object({
        id: z.string().max(100),
        label: z.string().max(200),
        width: z.number().int().min(0).max(32000),
        height: z.number().int().min(0).max(32000),
        primary: z.boolean(),
      }),
    )
    .max(16),
  system: z.object({
    manufacturer: z.string().max(200).optional(),
    model: z.string().max(200).optional(),
    hypervisorPresent: z.boolean().optional(),
    virtualizationSecurity: z.boolean().optional(),
    vmIndicators: z.array(z.string().max(200)).max(8),
    remoteSession: z.boolean().optional(),
    error: z.string().max(500).optional(),
  }),
});
const eventSchema = z.object({
  kind: z.string().max(100),
  detail: z.string().max(1000).default(""),
  data: z
    .record(
      z.string(),
      z.union([
        z.string().max(500),
        z.number().finite(),
        z.boolean(),
        z.null(),
      ]),
    )
    .default({}),
});
const sourceSchema = z.enum(["laptop-camera", "screen", "desk-camera"]);
const signalSchema = z.object({
  target: z.string().max(100),
  description: z
    .object({ type: z.enum(["offer", "answer"]), sdp: z.string().max(60000) })
    .optional(),
  candidate: z
    .object({
      candidate: z.string().max(4000).optional(),
      sdpMid: z.string().max(100).nullable().optional(),
      sdpMLineIndex: z.number().int().nullable().optional(),
      usernameFragment: z.string().max(200).nullable().optional(),
    })
    .optional(),
  labels: z
    .record(z.string().max(100), sourceSchema)
    .refine((x) => Object.keys(x).length <= 3)
    .optional(),
});
type Config = {
  store: Store;
  publicBaseUrl: string;
  iceServers?: RTCIceServer[];
  production?: boolean;
};
type RecordRow = Recording & { nextSeq: number; lastHash: string | null };

export function createService(config: Config) {
  const { store } = config;
  const app = express();
  let io: Server;
  const participants = new Map<string, { sessionId: string; role: Role }>();
  const recordingLocks = new Set<string>();
  const purgingSessions = new Set<string>();
  const origin = new URL(config.publicBaseUrl).origin;
  const allowedOrigin = (value: string | undefined, host?: string) => {
    if (!value) return true;
    try {
      const url = new URL(value);
      return (
        url.origin === origin ||
        (url.protocol === "https:" && url.host === host)
      );
    } catch {
      return false;
    }
  };
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Permissions-Policy",
      "camera=(self), microphone=(self), display-capture=(self)",
    );
    if (config.production)
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' wss:; frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
      );
    if (req.path.startsWith("/api")) res.setHeader("Cache-Control", "no-store");
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      !allowedOrigin(req.headers.origin, req.headers.host)
    )
      return res.status(403).json({ error: "Request origin rejected." });
    next();
  });
  app.use(express.json({ limit: "80kb" }));
  const authenticated = (req: Request, res: Response, next: NextFunction) => {
    if (!store.authorize(req.headers.cookie))
      return res
        .status(401)
        .json({ error: "Sign in to access this interview." });
    next();
  };
  const sessionRequired = (req: Request, res: Response, next: NextFunction) => {
    if (!store.getSession(String(req.params.id)))
      return res.status(404).json({ error: "Interview not found." });
    next();
  };
  const present = (id: string) =>
    [...participants.values()]
      .filter((p) => p.sessionId === id)
      .map((p) => p.role);
  const publish = (id: string) => io?.to(`review:${id}`).emit("updated");
  const event = (...args: Parameters<Store["event"]>) => {
    const result = store.event(...args);
    publish(args[0]);
    return result;
  };
  const links = (id: string) => {
    const laptopToken = store.makeInvite(id, "laptop");
    return {
      candidateUrl: `${config.publicBaseUrl}/join/${laptopToken}`,
      phoneUrl: `${config.publicBaseUrl}/phone/${store.phoneInvite(laptopToken)}`,
    };
  };
  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.get("/api/config", (_req, res) =>
    res.json({
      publicBaseUrl: config.publicBaseUrl,
      version: "0.1.0",
      desktopAvailable: false,
    }),
  );
  app.get("/api/auth", (req, res) =>
    res.json({ authenticated: store.authorize(req.headers.cookie) }),
  );
  app.post(
    "/api/auth/login",
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 15,
      standardHeaders: true,
      legacyHeaders: false,
    }),
    (req, res) => {
      const { password } = z
        .object({ password: z.string().min(1).max(500) })
        .parse(req.body);
      if (!store.checkPassword(password))
        return res.status(401).json({ error: "The password is incorrect." });
      res.cookie("cv_auth", store.login(), {
        httpOnly: true,
        secure: true,
        sameSite: "strict",
        maxAge: 12 * 60 * 60 * 1000,
        path: "/",
      });
      res.json({ ok: true });
    },
  );
  app.post("/api/auth/logout", authenticated, (req, res) => {
    store.logout(req.headers.cookie);
    for (const socket of io?.sockets.sockets.values() || [])
      if (
        socket.data.role === "reviewer" &&
        !store.authorize(socket.handshake.headers.cookie)
      )
        socket.disconnect(true);
    res
      .clearCookie("cv_auth", {
        httpOnly: true,
        secure: true,
        sameSite: "strict",
        path: "/",
      })
      .json({ ok: true });
  });
  app.get("/api/sessions", authenticated, (_req, res) =>
    res.json(store.list().map((s) => ({ ...s, present: present(s.id) }))),
  );
  app.post("/api/sessions", authenticated, (req, res) => {
    const input = z
      .object({
        candidateName: z.string().trim().min(1).max(100),
        roleTitle: z.string().trim().min(1).max(120),
        policy: policySchema,
      })
      .parse(req.body);
    const session = store.create(
      input.candidateName,
      input.roleTitle,
      input.policy,
    );
    res.status(201).json({ session, links: links(session.id) });
  });
  app.get("/api/sessions/:id", authenticated, sessionRequired, (req, res) => {
    const id = String(req.params.id);
    res.json({
      session: { ...store.getSession(id), present: present(id) },
      events: store.events(id),
      recordings: store.recordings(id),
      telemetry: store.telemetry(id),
    });
  });
  app.get(
    "/api/sessions/:id/export",
    authenticated,
    sessionRequired,
    (req, res) => {
      const id = String(req.params.id);
      res
        .attachment(`clearview-${id}.json`)
        .json({
          exportedAt: new Date().toISOString(),
          session: store.getSession(id),
          events: store.events(id),
          recordings: store.recordings(id),
          telemetry: store.telemetry(id),
          interpretation:
            "Observations for human review. Events do not establish cheating.",
        });
    },
  );
  app.post(
    "/api/sessions/:id/invites",
    authenticated,
    sessionRequired,
    (req, res) => {
      const id = String(req.params.id);
      if (store.getSession(id)!.state === "ended")
        return res.status(409).json({ error: "This interview has ended." });
      if (present(id).some((r) => r !== "reviewer"))
        return res
          .status(409)
          .json({
            error:
              "Participants are connected. Reuse the existing links or ask them to disconnect before replacing invites.",
          });
      event(
        id,
        "invites_renewed",
        "info",
        "reviewer",
        "Invite links renewed",
        "Previous invite links have been revoked.",
      );
      res.json(links(id));
    },
  );
  app.post(
    "/api/sessions/:id/end",
    authenticated,
    sessionRequired,
    (req, res) => {
      const id = String(req.params.id);
      if (store.getSession(id)!.state !== "ended") {
        store.db
          .prepare("UPDATE sessions SET state=?,endedAt=? WHERE id=?")
          .run("ended", new Date().toISOString(), id);
        store.db.prepare("DELETE FROM invites WHERE sessionId=?").run(id);
        event(
          id,
          "session_ended",
          "info",
          "reviewer",
          "Interview ended",
          "Capture stopped and participant invite links revoked.",
        );
        io?.to(`session:${id}`).emit("session-ended");
        for (const socket of io?.sockets.sockets.values() || [])
          if (socket.data.sessionId === id && socket.data.role !== "reviewer")
            socket.disconnect(true);
      }
      res.json({ ok: true });
    },
  );
  const purge = async (id: string) => {
    if (purgingSessions.has(id)) return;
    purgingSessions.add(id);
    try {
      io?.to(`session:${id}`).emit("session-ended");
      for (const socket of io?.sockets.sockets.values() || [])
        if (socket.data.sessionId === id) socket.disconnect(true);
      const root = resolve(store.directory, "recordings");
      const target = resolve(root, id);
      if (!target.startsWith(root + sep))
        throw new Error("Invalid recording directory.");
      // Revoke access before removing media. Failed removal can be retried on the next sweep.
      store.db
        .prepare("UPDATE sessions SET state=?,expiresAt=? WHERE id=?")
        .run("ended", new Date(0).toISOString(), id);
      store.db.prepare("DELETE FROM invites WHERE sessionId=?").run(id);
      // Let any chunk that was already accepted finish before removing its directory.
      // Expiry has already revoked new uploads, so cleanup cannot race directory recreation.
      const deadline = Date.now() + 10_000;
      while (
        [...recordingLocks].some(
          (recordingId) =>
            (
              store.db
                .prepare("SELECT sessionId FROM recordings WHERE id=?")
                .get(recordingId) as { sessionId: string } | undefined
            )?.sessionId === id,
        )
      ) {
        if (Date.now() > deadline)
          throw new Error(
            "A recording write is still active; retention cleanup will retry.",
          );
        await new Promise((r) => setTimeout(r, 50));
      }
      await rm(target, { recursive: true, force: true });
      store.db.prepare("DELETE FROM sessions WHERE id=?").run(id);
    } finally {
      purgingSessions.delete(id);
    }
  };
  app.delete(
    "/api/sessions/:id",
    authenticated,
    sessionRequired,
    async (req, res) => {
      await purge(String(req.params.id));
      res.json({ ok: true });
    },
  );
  app.patch(
    "/api/sessions/:id/events/:eventId",
    authenticated,
    sessionRequired,
    (req, res) => {
      const input = z
        .object({
          reviewStatus: z.enum(["unreviewed", "acknowledged", "dismissed"]),
          note: z.string().trim().max(1000),
        })
        .parse(req.body);
      const result = store.db
        .prepare(
          "UPDATE events SET reviewStatus=?,note=? WHERE id=? AND sessionId=?",
        )
        .run(
          input.reviewStatus,
          input.note,
          String(req.params.eventId),
          String(req.params.id),
        );
      if (!result.changes)
        return res.status(404).json({ error: "Event not found." });
      publish(String(req.params.id));
      res.json({ ok: true });
    },
  );
  app.post(
    "/api/sessions/:id/events",
    authenticated,
    sessionRequired,
    (req, res) => {
      const input = eventSchema.parse(req.body);
      const definition =
        reviewerEvents[input.kind as keyof typeof reviewerEvents];
      if (!definition)
        return res.status(400).json({ error: "Unsupported observation." });
      if (store.getSession(String(req.params.id))!.state === "ended")
        return res.status(409).json({ error: "This interview has ended." });
      res
        .status(201)
        .json(
          event(
            String(req.params.id),
            input.kind,
            definition[0],
            "reviewer",
            definition[1],
            input.detail,
            input.data,
          ),
        );
    },
  );
  app.get(
    "/api/invites/:token",
    rateLimit({
      windowMs: 60_000,
      limit: 120,
      standardHeaders: true,
      legacyHeaders: false,
    }),
    (req, res) => {
      const invite = store.invite(String(req.params.token));
      if (!invite)
        return res
          .status(410)
          .json({
            error:
              "This invite is invalid, expired, or the interview has ended.",
          });
      res.json({
        session: invite.session,
        role: invite.role,
        iceServers: config.iceServers || [],
        serverTime: new Date().toISOString(),
      });
    },
  );
  app.post("/api/invites/:token/consent", (req, res) => {
    const raw = String(req.params.token),
      invite = store.invite(raw);
    if (!invite)
      return res.status(410).json({ error: "This invite is no longer valid." });
    z.object({ accepted: z.literal(true) }).parse(req.body);
    if (!invite.consentAt) {
      store.consent(raw);
      event(
        invite.session.id,
        "consent_given",
        "info",
        invite.role,
        "Monitoring consent recorded",
        `Candidate accepted ${invite.role} monitoring. Recording ${invite.session.policy.recordingEnabled ? "enabled" : "disabled"}.`,
        { policy: JSON.stringify(invite.session.policy) },
      );
    }
    res.json({ ok: true });
  });
  app.post("/api/invites/:token/phone", (req, res) => {
    const invite = store.invite(String(req.params.token));
    if (!invite || invite.role !== "laptop" || !invite.consentAt)
      return res
        .status(403)
        .json({
          error: "Join from the laptop and accept the monitoring rules first.",
        });
    res.json({
      phoneUrl: `${config.publicBaseUrl}/phone/${store.phoneInvite(String(req.params.token))}`,
    });
  });
  app.get("/api/ice", authenticated, (_req, res) =>
    res.json(config.iceServers || []),
  );
  app.post(
    "/api/sessions/:id/recordings",
    authenticated,
    sessionRequired,
    (req, res) => {
      const session = store.getSession(String(req.params.id))!;
      if (
        !session.policy.recordingEnabled ||
        session.state === "ended" ||
        purgingSessions.has(session.id)
      )
        return res
          .status(409)
          .json({
            error: "Recording is not enabled for this active interview.",
          });
      const input = z
        .object({
          source: sourceSchema,
          mimeType: z.enum([
            "video/webm",
            "video/webm;codecs=vp8",
            "video/webm;codecs=vp9",
            "video/mp4",
          ]),
        })
        .parse(req.body);
      const id = randomUUID();
      const startedAt = new Date().toISOString();
      store.db
        .prepare(
          "INSERT INTO recordings(id,sessionId,source,startedAt,mimeType) VALUES (?,?,?,?,?)",
        )
        .run(id, session.id, input.source, startedAt, input.mimeType);
      publish(session.id);
      res.status(201).json({ id, startedAt });
    },
  );
  const getRecording = (id: string) =>
    store.db.prepare("SELECT * FROM recordings WHERE id=?").get(id) as
      RecordRow | undefined;
  const recordingPath = (r: RecordRow) =>
    join(
      store.directory,
      "recordings",
      r.sessionId,
      `${r.id}.${r.mimeType.includes("mp4") ? "mp4" : "webm"}`,
    );
  app.post(
    "/api/recordings/:recordingId/chunks",
    authenticated,
    express.raw({ type: "application/octet-stream", limit: "8mb" }),
    async (req, res) => {
      const id = String(req.params.recordingId),
        r = getRecording(id);
      if (!r) return res.status(404).json({ error: "Recording not found." });
      const seq = Number(req.headers["x-chunk-sequence"]);
      if (
        !Number.isInteger(seq) ||
        seq < 0 ||
        !Buffer.isBuffer(req.body) ||
        !req.body.length
      )
        return res.status(400).json({ error: "Invalid recording chunk." });
      const hash = createHash("sha256").update(req.body).digest("hex");
      if (seq === r.nextSeq - 1 && hash === r.lastHash)
        return res.json({ ok: true, duplicate: true });
      if (r.endedAt)
        return res.status(409).json({ error: "Recording is finalized." });
      if (seq !== r.nextSeq || recordingLocks.has(id))
        return res
          .status(409)
          .json({ error: "Recording chunks must arrive in sequence." });
      if (r.bytes + req.body.length > 500 * 1024 * 1024)
        return res
          .status(413)
          .json({ error: "The recording reached the 500 MB limit." });
      const session = store.getSession(r.sessionId);
      if (!session || Date.parse(session.expiresAt) <= Date.now())
        return res
          .status(410)
          .json({ error: "Recording retention has expired." });
      recordingLocks.add(id);
      try {
        const path = recordingPath(r);
        await mkdir(join(store.directory, "recordings", r.sessionId), {
          recursive: true,
        });
        // A partial append after a crash must never be silently treated as complete evidence.
        const diskSize = await stat(path)
          .then((s) => s.size)
          .catch(() => 0);
        if (diskSize !== r.bytes)
          throw new Error(
            "Recording storage is inconsistent. Start a new recording.",
          );
        await appendFile(path, req.body);
        store.db
          .prepare(
            "UPDATE recordings SET bytes=bytes+?,nextSeq=nextSeq+1,lastHash=? WHERE id=?",
          )
          .run(req.body.length, hash, id);
        res.json({ ok: true });
      } finally {
        recordingLocks.delete(id);
      }
    },
  );
  app.post(
    "/api/recordings/:recordingId/finalize",
    authenticated,
    async (req, res) => {
      const id = String(req.params.recordingId),
        r = getRecording(id);
      if (!r) return res.status(404).json({ error: "Recording not found." });
      if (recordingLocks.has(id))
        return res
          .status(409)
          .json({ error: "Recording upload is still in progress." });
      if (!r.endedAt) {
        const hash = createHash("sha256");
        if (r.bytes)
          for await (const chunk of createReadStream(recordingPath(r)))
            hash.update(chunk);
        store.db
          .prepare("UPDATE recordings SET endedAt=?,sha256=? WHERE id=?")
          .run(
            new Date().toISOString(),
            r.bytes ? hash.digest("hex") : null,
            id,
          );
        publish(r.sessionId);
      }
      res.json({ ok: true });
    },
  );
  app.get("/api/recordings/:recordingId/media", authenticated, (req, res) => {
    const r = getRecording(String(req.params.recordingId));
    if (!r || !r.bytes)
      return res.status(404).json({ error: "Recording not available." });
    const session = store.getSession(r.sessionId);
    if (!session || Date.parse(session.expiresAt) <= Date.now())
      return res
        .status(410)
        .json({ error: "Recording retention has expired." });
    // The private data directory may begin with a dot. Only this generated,
    // authenticated path is allowed; it is never exposed as a static directory.
    res
      .type(r.mimeType)
      .sendFile(resolve(recordingPath(r)), { dotfiles: "allow" });
  });
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "API endpoint not found." }),
  );
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof z.ZodError)
      return res
        .status(400)
        .json({
          error: err.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; "),
        });
    if (err.status === 413)
      return res.status(413).json({ error: "Upload is too large." });
    if (err.type === "entity.parse.failed")
      return res.status(400).json({ error: "Invalid JSON." });
    console.error("Request failed:", err.message);
    res
      .status(500)
      .type("application/json")
      .json({
        error:
          "The request could not be completed. Check server storage and retry.",
      });
  });

  function attach(server: HttpServer | HttpsServer) {
    io = new Server(server, {
      maxHttpBufferSize: 80_000,
      allowRequest: (req, callback) =>
        callback(null, allowedOrigin(req.headers.origin, req.headers.host)),
    });
    const notifyPeers = (id: string) => {
      const peers = [...participants.entries()]
        .filter(([, p]) => p.sessionId === id)
        .map(([socketId, p]) => ({ id: socketId, role: p.role }));
      io.to(`session:${id}`).emit("participants", peers);
      publish(id);
    };
    io.use((socket, next) => {
      const auth = socket.handshake.auth;
      if (auth.role === "reviewer") {
        if (
          !store.authorize(socket.handshake.headers.cookie) ||
          !store.getSession(auth.sessionId)
        )
          return next(new Error("Sign in and select an existing interview."));
        socket.data = { role: "reviewer", sessionId: auth.sessionId };
      } else {
        if (typeof auth.token !== "string" || auth.token.length > 100)
          return next(new Error("Invalid invite."));
        const invite = store.invite(auth.token);
        if (!invite || !invite.consentAt || auth.role !== invite.role)
          return next(
            new Error("Accept the monitoring rules with a valid invite."),
          );
        if (present(invite.session.id).includes(invite.role))
          return next(
            new Error(
              `A ${invite.role} is already connected. Close the other monitoring tab first.`,
            ),
          );
        socket.data = {
          role: invite.role,
          sessionId: invite.session.id,
          token: auth.token,
        };
      }
      next();
    });
    io.on("connection", (socket) => {
      const { role, sessionId } = socket.data as {
        role: Role;
        sessionId: string;
      };
      if (role !== "reviewer" && present(sessionId).includes(role)) {
        socket.emit(
          "monitor-error",
          "Another device has already joined this role.",
        );
        socket.disconnect(true);
        return;
      }
      participants.set(socket.id, { role, sessionId });
      socket.join(`session:${sessionId}`);
      if (role === "reviewer") socket.join(`review:${sessionId}`);
      else {
        if (
          role === "laptop" &&
          store.getSession(sessionId)!.state === "waiting"
        )
          store.db
            .prepare("UPDATE sessions SET state=?,startedAt=? WHERE id=?")
            .run("live", new Date().toISOString(), sessionId);
        event(
          sessionId,
          "participant_connected",
          "info",
          role,
          `${role === "phone" ? "Desk camera device" : "Laptop"} connected`,
          "Connection established. Capture readiness is reported separately.",
        );
      }
      notifyPeers(sessionId);
      let messages = 0,
        resetAt = Date.now(),
        lastTelemetry = 0;
      const valid = () => {
        if (Date.now() - resetAt > 60_000) {
          messages = 0;
          resetAt = Date.now();
        }
        if (++messages > 300) {
          socket.emit("monitor-error", "Too many monitoring messages.");
          socket.disconnect(true);
          return false;
        }
        const session = store.getSession(sessionId);
        if (!session) return false;
        if (role === "reviewer")
          return store.authorize(socket.handshake.headers.cookie);
        return (
          session.state !== "ended" && Boolean(store.invite(socket.data.token))
        );
      };
      socket.on("signal", (payload: unknown) => {
        if (!valid()) return;
        const input = signalSchema.safeParse(payload);
        if (!input.success) return;
        const target = participants.get(input.data.target);
        if (
          !target ||
          target.sessionId !== sessionId ||
          (role === "reviewer") === (target.role === "reviewer")
        )
          return;
        // Only monitoring sources offer; viewers answer. Labels cannot claim another role's camera.
        if (
          input.data.description?.type ===
          (role === "reviewer" ? "offer" : "answer")
        )
          return;
        if (
          input.data.labels &&
          Object.values(input.data.labels).some((source) =>
            role === "phone"
              ? source !== "desk-camera"
              : role === "laptop"
                ? source === "desk-camera"
                : true,
          )
        )
          return;
        io.to(input.data.target).emit("signal", {
          ...input.data,
          from: socket.id,
        });
      });
      socket.on(
        "observation",
        (payload: unknown, ack?: (r: unknown) => void) => {
          if (!valid() || role === "reviewer") return;
          const input = eventSchema.safeParse(payload);
          if (!input.success) return ack?.({ error: "Invalid observation." });
          const definition =
            participantEvents[
              input.data.kind as keyof typeof participantEvents
            ];
          if (
            !definition ||
            (role === "phone" && input.data.kind.startsWith("screen_"))
          )
            return;
          event(
            sessionId,
            input.data.kind,
            definition[0],
            role,
            definition[1],
            input.data.detail,
            input.data.data,
          );
          ack?.({ ok: true });
        },
      );
      socket.on("telemetry", (payload: unknown) => {
        if (!valid() || role !== "laptop" || Date.now() - lastTelemetry < 1000)
          return;
        const input = telemetrySchema.safeParse(payload);
        if (!input.success) return;
        lastTelemetry = Date.now();
        const current: DesktopTelemetry = input.data,
          previous = store.telemetry(sessionId);
        store.db
          .prepare("UPDATE sessions SET telemetry=? WHERE id=?")
          .run(JSON.stringify(current), sessionId);
        const displayKey = (t: DesktopTelemetry) =>
          JSON.stringify(
            t.displays.map((d) => [d.id, d.width, d.height]).sort(),
          );
        if (!previous || displayKey(previous) !== displayKey(current)) {
          const count = current.displays.length,
            policy = store.getSession(sessionId)!.policy;
          event(
            sessionId,
            "displays_observed",
            count > 1 && !policy.extraDisplaysAllowed ? "review" : "info",
            "laptop",
            `${count} display${count === 1 ? "" : "s"} reported by the operating system`,
            "Display information comes from the candidate desktop client; it does not establish physical device coverage.",
            { displays: JSON.stringify(current.displays) },
          );
        }
        if (
          (!previous ||
            JSON.stringify(previous.system) !==
              JSON.stringify(current.system)) &&
          (current.system.vmIndicators.length ||
            current.system.hypervisorPresent ||
            current.system.error ||
            current.system.remoteSession)
        ) {
          event(
            sessionId,
            "system_indicators",
            current.system.vmIndicators.length || current.system.remoteSession
              ? "review"
              : current.system.error
                ? "technical"
                : "info",
            "laptop",
            "System environment indicators recorded",
            current.system.error ||
              "Virtualization and remote-session indicators need context. Windows security features may legitimately use a hypervisor.",
            { system: JSON.stringify(current.system) },
          );
        }
        publish(sessionId);
      });
      socket.on("disconnect", () => {
        participants.delete(socket.id);
        const session = store.getSession(sessionId);
        if (session && role !== "reviewer" && session.state !== "ended")
          event(
            sessionId,
            "participant_disconnected",
            "technical",
            role,
            `${role === "phone" ? "Desk camera device" : "Laptop"} disconnected`,
            "Check network connectivity and reconnect. Disconnection does not establish a rule violation.",
          );
        notifyPeers(sessionId);
      });
    });
    return io;
  }
  async function sweep() {
    for (const s of store.list())
      if (Date.parse(s.expiresAt) <= Date.now()) await purge(s.id);
    for (const socket of io?.sockets.sockets.values() || []) {
      if (
        socket.data.role === "reviewer"
          ? !store.authorize(socket.handshake.headers.cookie)
          : !store.invite(socket.data.token)
      )
        socket.disconnect(true);
    }
  }
  return {
    app,
    attach,
    sweep,
    present,
    close: async () => {
      await new Promise<void>((r) => (io ? io.close(() => r()) : r()));
    },
  };
}
