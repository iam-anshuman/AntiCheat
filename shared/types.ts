export type Role = "laptop" | "phone" | "reviewer";
export type Source = "laptop-camera" | "screen" | "desk-camera";
export type EventLevel = "info" | "review" | "technical";
export type SessionState = "waiting" | "live" | "ended";
export interface Policy {
  aiAllowed: boolean;
  extraDisplaysAllowed: boolean;
  phoneRequired: boolean;
  recordingEnabled: boolean;
  retentionDays: number;
}
export interface InterviewSession {
  id: string;
  candidateName: string;
  roleTitle: string;
  state: SessionState;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  expiresAt: string;
  policy: Policy;
  eventCount?: number;
  reviewCount?: number;
  present?: Role[];
}
export interface EvidenceEvent {
  id: string;
  sessionId: string;
  at: string;
  kind: string;
  level: EventLevel;
  actor: Role | "system";
  title: string;
  detail: string;
  reviewStatus: "unreviewed" | "acknowledged" | "dismissed";
  note: string;
  data: Record<string, unknown>;
}
export interface Recording {
  id: string;
  sessionId: string;
  source: Source;
  startedAt: string;
  endedAt: string | null;
  bytes: number;
  mimeType: string;
  sha256: string | null;
}
export interface DesktopTelemetry {
  platform: string;
  displays: {
    id: string;
    label: string;
    width: number;
    height: number;
    primary: boolean;
  }[];
  system: {
    manufacturer?: string;
    model?: string;
    hypervisorPresent?: boolean;
    virtualizationSecurity?: boolean;
    vmIndicators: string[];
    remoteSession?: boolean;
    error?: string;
  };
}
export interface Participant {
  id: string;
  role: Role;
}
export interface Signal {
  target: string;
  from?: string;
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  labels?: Record<string, Source>;
}
export interface SessionDetail {
  session: InterviewSession;
  events: EvidenceEvent[];
  recordings: Recording[];
  telemetry: DesktopTelemetry | null;
}
export interface AppConfig {
  publicBaseUrl: string;
  version: string;
  desktopAvailable: boolean;
}
export interface Invite {
  session: InterviewSession;
  role: "laptop" | "phone";
  iceServers: RTCIceServer[];
  serverTime: string;
}
export interface DesktopBridge {
  platform: string;
  telemetry(): Promise<DesktopTelemetry>;
  onDisplaysChanged(callback: () => void): () => void;
  allowScreenCapture(): Promise<void>;
}
declare global {
  interface Window {
    clearviewDesktop?: DesktopBridge;
  }
}
