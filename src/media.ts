import type { Socket } from "socket.io-client";
import type { Participant, Signal, Source } from "../shared/types";
import { api, post } from "./api";

export class Broadcast {
  private peers = new Map<string, RTCPeerConnection>();
  private pending = new Map<string, RTCIceCandidateInit[]>();
  private streams = new Map<Source, MediaStream>();
  private participants: Participant[] = [];
  constructor(
    private socket: Socket,
    private iceServers: RTCIceServer[],
    private onError: (s: string) => void,
  ) {
    socket.on("participants", this.update);
    socket.on("signal", this.signal);
    socket.on("disconnect", this.disconnect);
  }
  setStreams(streams: Map<Source, MediaStream>) {
    this.streams = streams;
    this.closePeers();
    this.update(this.participants);
  }
  private update = (participants: Participant[]) => {
    this.participants = participants;
    const viewers = participants.filter((p) => p.role === "reviewer");
    for (const [id, pc] of this.peers)
      if (!viewers.some((p) => p.id === id)) {
        pc.close();
        this.peers.delete(id);
        this.pending.delete(id);
      }
    for (const viewer of viewers)
      if (!this.peers.has(viewer.id) && this.streams.size)
        void this.offer(viewer.id);
  };
  private async offer(id: string) {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this.peers.set(id, pc);
    const labels: Record<string, Source> = {};
    for (const [source, stream] of this.streams) {
      labels[stream.id] = source;
      for (const track of stream.getTracks()) pc.addTrack(track, stream);
    }
    pc.onicecandidate = (e) => {
      if (e.candidate)
        this.socket.emit("signal", {
          target: id,
          candidate: e.candidate.toJSON(),
        });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed")
        this.onError(
          "Video connection failed. Check the network or TURN configuration.",
        );
    };
    try {
      await pc.setLocalDescription(await pc.createOffer());
      if (pc.signalingState !== "closed")
        this.socket.emit("signal", {
          target: id,
          description: pc.localDescription?.toJSON(),
          labels,
        });
    } catch (err) {
      if (pc.signalingState !== "closed") this.onError((err as Error).message);
    }
  }
  private signal = async (message: Signal) => {
    if (!message.from) return;
    const pc = this.peers.get(message.from);
    if (!pc) return;
    try {
      if (message.description) {
        await pc.setRemoteDescription(message.description);
        for (const candidate of this.pending.get(message.from) || [])
          await pc.addIceCandidate(candidate);
        this.pending.delete(message.from);
      } else if (message.candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(message.candidate);
        else
          this.pending.set(message.from, [
            ...(this.pending.get(message.from) || []),
            message.candidate,
          ]);
      }
    } catch (err) {
      if (pc.signalingState !== "closed") this.onError((err as Error).message);
    }
  };
  private disconnect = () => this.closePeers();
  private closePeers() {
    for (const pc of this.peers.values()) pc.close();
    this.peers.clear();
    this.pending.clear();
  }
  close() {
    this.socket.off("participants", this.update);
    this.socket.off("signal", this.signal);
    this.socket.off("disconnect", this.disconnect);
    this.closePeers();
  }
}

export class Viewer {
  private peers = new Map<string, RTCPeerConnection>();
  private pending = new Map<string, RTCIceCandidateInit[]>();
  private sources = new Map<string, Source[]>();
  constructor(
    private socket: Socket,
    private iceServers: RTCIceServer[],
    private onStream: (source: Source, stream: MediaStream | null) => void,
    private onError: (s: string) => void,
  ) {
    socket.on("signal", this.signal);
    socket.on("participants", this.update);
    socket.on("disconnect", this.disconnect);
  }
  private drop(id: string) {
    this.peers.get(id)?.close();
    this.peers.delete(id);
    this.pending.delete(id);
    for (const source of this.sources.get(id) || [])
      this.onStream(source, null);
    this.sources.delete(id);
  }
  private update = (participants: Participant[]) => {
    for (const id of this.peers.keys())
      if (!participants.some((p) => p.id === id)) this.drop(id);
  };
  private signal = async (message: Signal) => {
    if (!message.from) return;
    const id = message.from;
    try {
      if (message.description?.type === "offer") {
        const earlyCandidates = this.pending.get(id) || [];
        this.drop(id);
        const pc = new RTCPeerConnection({ iceServers: this.iceServers });
        this.peers.set(id, pc);
        const labels = message.labels || {};
        this.sources.set(id, Object.values(labels));
        pc.ontrack = (e) => {
          const stream = e.streams[0],
            source = stream && labels[stream.id];
          if (source) {
            this.onStream(source, stream);
            e.track.onended = () => {
              if (this.peers.get(id) === pc) this.onStream(source, null);
            };
          }
        };
        pc.onicecandidate = (e) => {
          if (e.candidate)
            this.socket.emit("signal", {
              target: id,
              candidate: e.candidate.toJSON(),
            });
        };
        pc.onconnectionstatechange = () => {
          if (pc.connectionState === "failed") {
            this.onError(
              "A video feed could not connect. Check connectivity and TURN configuration.",
            );
            for (const source of this.sources.get(id) || [])
              this.onStream(source, null);
          }
        };
        await pc.setRemoteDescription(message.description);
        for (const candidate of [
          ...earlyCandidates,
          ...(this.pending.get(id) || []),
        ])
          await pc.addIceCandidate(candidate);
        this.pending.delete(id);
        await pc.setLocalDescription(await pc.createAnswer());
        if (pc.signalingState !== "closed")
          this.socket.emit("signal", {
            target: id,
            description: pc.localDescription?.toJSON(),
          });
      } else if (message.candidate) {
        const pc = this.peers.get(id);
        if (pc?.remoteDescription) await pc.addIceCandidate(message.candidate);
        else
          this.pending.set(id, [
            ...(this.pending.get(id) || []),
            message.candidate,
          ]);
      }
    } catch (err) {
      if (this.peers.get(id)?.signalingState !== "closed")
        this.onError((err as Error).message);
    }
  };
  private disconnect = () => {
    for (const id of this.peers.keys()) this.drop(id);
  };
  close() {
    this.socket.off("signal", this.signal);
    this.socket.off("participants", this.update);
    this.socket.off("disconnect", this.disconnect);
    this.disconnect();
  }
}

export class EvidenceRecorder {
  private recorder?: MediaRecorder;
  private stopped = false;
  private failed = false;
  private queue: Promise<void> = Promise.resolve();
  private pendingBytes = 0;
  private id?: string;
  private sequence = 0;
  constructor(
    private sessionId: string,
    private source: Source,
    private onError: (message: string) => void,
  ) {}
  async start(stream: MediaStream) {
    try {
      const mimeType = [
        "video/webm;codecs=vp8",
        "video/webm",
        "video/mp4",
      ].find((t) => MediaRecorder.isTypeSupported(t));
      if (!mimeType)
        throw new Error(
          "This browser does not support evidence recording. Use Chrome or Edge.",
        );
      this.recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: this.source === "screen" ? 900_000 : 450_000,
      });
      const record = await post<{ id: string }>(
        `/api/sessions/${this.sessionId}/recordings`,
        { source: this.source, mimeType },
      );
      this.id = record.id;
      this.recorder.ondataavailable = (e) => {
        if (!e.data.size || this.failed) return;
        this.pendingBytes += e.data.size;
        if (this.pendingBytes > 24 * 1024 * 1024) {
          this.fail(
            "Recording upload is too slow. Recording stopped to protect memory.",
          );
          return;
        }
        const seq = this.sequence++;
        this.queue = this.queue.then(async () => {
          if (this.failed) return;
          let error: unknown;
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              await api(`/api/recordings/${this.id}/chunks`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/octet-stream",
                  "X-Chunk-Sequence": String(seq),
                },
                body: e.data,
              });
              this.pendingBytes -= e.data.size;
              return;
            } catch (err) {
              error = err;
              if (attempt < 2)
                await new Promise((r) => setTimeout(r, 750 * (attempt + 1)));
            }
          }
          this.fail(`Evidence upload failed: ${(error as Error).message}`);
        });
      };
      this.recorder.onerror = () =>
        this.fail("The browser recorder reported an error.");
      this.recorder.onstop = () => {
        this.queue = this.queue.then(async () => {
          if (this.id)
            await post(`/api/recordings/${this.id}/finalize`).catch((err) =>
              this.onError(err.message),
            );
        });
      };
      if (this.stopped) {
        await post(`/api/recordings/${this.id}/finalize`);
        return;
      }
      this.recorder.start(4000);
    } catch (err) {
      this.fail((err as Error).message);
    }
  }
  private fail(message: string) {
    if (this.failed) return;
    this.failed = true;
    this.onError(message);
    this.stop();
  }
  stop() {
    this.stopped = true;
    if (this.recorder && this.recorder.state !== "inactive")
      this.recorder.stop();
  }
}
