import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createServer } from "node:http";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { io, type Socket } from "socket.io-client";
import { Store } from "../server/store.js";
import { createService } from "../server/app.js";
import type { Policy } from "../shared/types.js";

const policy: Policy = {
  aiAllowed: false,
  extraDisplaysAllowed: false,
  phoneRequired: true,
  recordingEnabled: true,
  retentionDays: 7,
};
describe("Interview access, evidence and lifecycle", () => {
  let directory: string,
    store: Store,
    service: ReturnType<typeof createService>,
    cookie: string,
    base: string;
  const sockets: Socket[] = [];
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), ".clearview-tests-"));
    store = new Store(directory, "test-reviewer-password");
    service = createService({ store, publicBaseUrl: "https://clearview.test" });
    const server = createServer(service.app);
    service.attach(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const login = await request(service.app)
      .post("/api/auth/login")
      .send({ password: "test-reviewer-password" });
    cookie = login.headers["set-cookie"][0].split(";")[0];
  });
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.disconnect();
    await service.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const create = async (custom: Partial<Policy> = {}) => {
    const result = await request(service.app)
      .post("/api/sessions")
      .set("Cookie", cookie)
      .send({
        candidateName: "Alex Morgan",
        roleTitle: "Software engineer",
        policy: { ...policy, ...custom },
      })
      .expect(201);
    return {
      ...result.body,
      token: result.body.links.candidateUrl.split("/").at(-1),
      phoneToken: result.body.links.phoneUrl.split("/").at(-1),
    };
  };
  const connect = async (auth: object, authenticated = false) => {
    const socket = io(base, {
      auth,
      transports: ["websocket"],
      reconnection: false,
      ...(authenticated ? { extraHeaders: { Cookie: cookie } } : {}),
    });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("connect_error", reject);
    });
    return socket;
  };
  const consent = (token: string) =>
    request(service.app)
      .post(`/api/invites/${token}/consent`)
      .send({ accepted: true })
      .expect(200);
  const pause = (ms = 80) => new Promise((r) => setTimeout(r, ms));

  it("requires authentication and secures the reviewer cookie", async () => {
    await request(service.app).get("/api/sessions").expect(401);
    await request(service.app)
      .post("/api/auth/login")
      .send({ password: "incorrect" })
      .expect(401);
    const login = await request(service.app)
      .post("/api/auth/login")
      .send({ password: "test-reviewer-password" })
      .expect(200);
    expect(login.headers["set-cookie"][0]).toMatch(/HttpOnly/);
    expect(login.headers["set-cookie"][0]).toMatch(/Secure/);
    expect(login.headers["set-cookie"][0]).toMatch(/SameSite=Strict/);
    await request(service.app)
      .post("/api/sessions")
      .set("Cookie", cookie)
      .set("Origin", "https://evil.test")
      .send({})
      .expect(403);
  });
  it("validates session rules, preserves data and never returns invite hashes", async () => {
    await request(service.app)
      .post("/api/sessions")
      .set("Cookie", cookie)
      .send({ candidateName: "", roleTitle: "Developer", policy })
      .expect(400);
    await request(service.app)
      .post("/api/sessions")
      .set("Cookie", cookie)
      .send({
        candidateName: "Alex",
        roleTitle: "Developer",
        policy: { ...policy, retentionDays: 99 },
      })
      .expect(400);
    const result = await create();
    const sessions = await request(service.app)
      .get("/api/sessions")
      .set("Cookie", cookie)
      .expect(200);
    expect(sessions.body[0].candidateName).toBe("Alex Morgan");
    expect(sessions.text).not.toContain(result.token);
    expect(
      store.db
        .prepare("SELECT hash FROM invites")
        .all()
        .some((r: any) => r.hash === result.token),
    ).toBe(false);
  });
  it("requires consent and the matching role, and rejects duplicate participant devices", async () => {
    const result = await create();
    await expect(
      connect({ role: "laptop", token: result.token }),
    ).rejects.toThrow(/Accept/);
    await consent(result.token);
    await expect(
      connect({ role: "phone", token: result.token }),
    ).rejects.toThrow(/Accept/);
    await connect({ role: "laptop", token: result.token });
    await expect(
      connect({ role: "laptop", token: result.token }),
    ).rejects.toThrow(/already/);
    expect(store.getSession(result.session.id)?.state).toBe("live");
    expect(
      store.events(result.session.id).some((e) => e.kind === "consent_given"),
    ).toBe(true);
  });
  it("keeps the phone QR stable when the laptop joins or reconnects", async () => {
    const result = await create();
    await consent(result.token);
    const pairing = await request(service.app)
      .post(`/api/invites/${result.token}/phone`)
      .send({})
      .expect(200);
    expect(pairing.body.phoneUrl).toBe(result.links.phoneUrl);
    await request(service.app)
      .get(`/api/invites/${result.phoneToken}`)
      .expect(200);
  });
  it("keeps signaling inside a session and protects reviewer observations", async () => {
    const first = await create(),
      second = await create();
    await consent(first.token);
    const laptop = await connect({ role: "laptop", token: first.token });
    const viewer = await connect(
      { role: "reviewer", sessionId: first.session.id },
      true,
    );
    const foreignViewer = await connect(
      { role: "reviewer", sessionId: second.session.id },
      true,
    );
    let received = 0,
      leaked = 0;
    viewer.on("signal", () => received++);
    foreignViewer.on("signal", () => leaked++);
    laptop.emit("signal", {
      target: viewer.id,
      description: { type: "offer", sdp: "test-offer" },
      labels: { a: "laptop-camera" },
    });
    laptop.emit("signal", {
      target: foreignViewer.id,
      description: { type: "offer", sdp: "test-offer" },
    });
    laptop.emit("observation", {
      kind: "multiple_faces",
      detail: "Spoofed reviewer observation",
    });
    await pause();
    expect(received).toBe(1);
    expect(leaked).toBe(0);
    expect(
      store.events(first.session.id).some((e) => e.kind === "multiple_faces"),
    ).toBe(false);
  });
  it("records display policy events without treating a legitimate hypervisor as a violation", async () => {
    const result = await create();
    await consent(result.token);
    const laptop = await connect({ role: "laptop", token: result.token });
    laptop.emit("telemetry", {
      platform: "win32",
      displays: [
        { id: "1", label: "Laptop", width: 1920, height: 1080, primary: true },
        {
          id: "2",
          label: "External",
          width: 1920,
          height: 1080,
          primary: false,
        },
      ],
      system: {
        hypervisorPresent: true,
        virtualizationSecurity: true,
        vmIndicators: [],
      },
    });
    await pause();
    const events = store.events(result.session.id);
    expect(events.find((e) => e.kind === "displays_observed")?.level).toBe(
      "review",
    );
    expect(events.find((e) => e.kind === "system_indicators")?.level).toBe(
      "info",
    );
    expect(store.telemetry(result.session.id)?.displays).toHaveLength(2);
  });
  it("keeps recording chunks sequential, idempotent, authenticated and checksummed", async () => {
    const result = await create();
    const recording = await request(service.app)
      .post(`/api/sessions/${result.session.id}/recordings`)
      .set("Cookie", cookie)
      .send({ source: "screen", mimeType: "video/webm;codecs=vp8" })
      .expect(201);
    const path = `/api/recordings/${recording.body.id}`;
    await request(service.app)
      .post(`${path}/chunks`)
      .set("Content-Type", "application/octet-stream")
      .set("X-Chunk-Sequence", "0")
      .send(Buffer.from("first"))
      .expect(401);
    await request(service.app)
      .post(`${path}/chunks`)
      .set("Cookie", cookie)
      .set("Content-Type", "application/octet-stream")
      .set("X-Chunk-Sequence", "1")
      .send(Buffer.from("wrong"))
      .expect(409);
    const chunk = () =>
      request(service.app)
        .post(`${path}/chunks`)
        .set("Cookie", cookie)
        .set("Content-Type", "application/octet-stream")
        .set("X-Chunk-Sequence", "0")
        .send(Buffer.from("first"));
    await chunk().expect(200);
    expect((await chunk().expect(200)).body.duplicate).toBe(true);
    await request(service.app)
      .post(`${path}/finalize`)
      .set("Cookie", cookie)
      .send({})
      .expect(200);
    expect(store.recordings(result.session.id)[0].bytes).toBe(5);
    expect(store.recordings(result.session.id)[0].sha256).toHaveLength(64);
    await request(service.app).get(`${path}/media`).expect(401);
    await request(service.app)
      .get(`${path}/media`)
      .set("Cookie", cookie)
      .expect(200);
    await request(service.app)
      .get(`${path}/media`)
      .set("Cookie", cookie)
      .set("Range", "bytes=0-2")
      .expect(206)
      .expect("Content-Range", "bytes 0-2/5");
    const content = await readFile(
      join(
        directory,
        "recordings",
        result.session.id,
        `${recording.body.id}.webm`,
      ),
    );
    expect(content.toString()).toBe("first");
  });
  it("honors recording opt-out and reviewer notes", async () => {
    const result = await create({ recordingEnabled: false });
    await request(service.app)
      .post(`/api/sessions/${result.session.id}/recordings`)
      .set("Cookie", cookie)
      .send({ source: "screen", mimeType: "video/webm" })
      .expect(409);
    const event = await request(service.app)
      .post(`/api/sessions/${result.session.id}/events`)
      .set("Cookie", cookie)
      .send({ kind: "bookmark", detail: "Candidate explained the solution." })
      .expect(201);
    await request(service.app)
      .patch(`/api/sessions/${result.session.id}/events/${event.body.id}`)
      .set("Cookie", cookie)
      .send({ reviewStatus: "dismissed", note: "Permitted assistance." })
      .expect(200);
    expect(store.events(result.session.id)[0].note).toBe(
      "Permitted assistance.",
    );
  });
  it("revokes invites and stops participants on session end", async () => {
    const result = await create();
    await consent(result.token);
    const laptop = await connect({ role: "laptop", token: result.token });
    const ended = new Promise<void>((resolve) =>
      laptop.once("session-ended", resolve),
    );
    await request(service.app)
      .post(`/api/sessions/${result.session.id}/end`)
      .set("Cookie", cookie)
      .send({})
      .expect(200);
    await ended;
    expect(store.getSession(result.session.id)?.state).toBe("ended");
    await request(service.app).get(`/api/invites/${result.token}`).expect(410);
    await request(service.app)
      .post(`/api/sessions/${result.session.id}/invites`)
      .set("Cookie", cookie)
      .send({})
      .expect(409);
  });
  it("deletes expired sessions and their evidence", async () => {
    const result = await create();
    store.db
      .prepare("UPDATE sessions SET expiresAt=? WHERE id=?")
      .run(new Date(0).toISOString(), result.session.id);
    await service.sweep();
    expect(store.getSession(result.session.id)).toBeUndefined();
    expect(store.events(result.session.id)).toHaveLength(0);
    await request(service.app).get(`/api/invites/${result.token}`).expect(410);
  });
  it("revokes reviewer HTTP and socket access after logout", async () => {
    const result = await create();
    const viewer = await connect(
      { role: "reviewer", sessionId: result.session.id },
      true,
    );
    await request(service.app)
      .post("/api/auth/logout")
      .set("Cookie", cookie)
      .send({})
      .expect(200);
    await pause();
    expect(viewer.connected).toBe(false);
    await request(service.app)
      .get("/api/sessions")
      .set("Cookie", cookie)
      .expect(401);
  });
});
