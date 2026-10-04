import { useEffect, useRef, type ReactNode } from "react";
import {
  ShieldCheck,
  X,
  Monitor,
  Camera,
  Smartphone,
  Copy,
  Check,
} from "lucide-react";
import { useState } from "react";
import type { Source } from "../shared/types";
import { sourceName } from "./api";

export function Brand({ light = false }: { light?: boolean }) {
  return (
    <div className={`brand ${light ? "light" : ""}`}>
      <span className="brand-icon">
        <ShieldCheck size={23} strokeWidth={1.8} />
      </span>
      <span>
        clearview<span className="brand-dot">.</span>
      </span>
    </div>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? "wide" : ""}`}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <header>
        <h2>{title}</h2>
        <button
          aria-label="Close dialog"
          className="icon-button"
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </header>
      {children}
    </dialog>
  );
}
export function CopyButton({
  value,
  label = "Copy link",
}: {
  value: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false),
    [error, setError] = useState("");
  return (
    <div>
      <button
        type="button"
        className="button secondary small"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          } catch {
            setError("Select and copy the link below.");
          }
        }}
      >
        {copied ? <Check size={15} /> : <Copy size={15} />}
        {copied ? "Copied" : label}
      </button>
      {error && <small className="error-text">{error}</small>}
    </div>
  );
}
export function Feed({
  source,
  stream,
  live = true,
  children,
}: {
  source: Source;
  stream?: MediaStream | null;
  live?: boolean;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current) {
      ref.current.srcObject = stream || null;
      if (stream) void ref.current.play().catch(() => {});
    }
  }, [stream]);
  const Icon =
    source === "screen"
      ? Monitor
      : source === "desk-camera"
        ? Smartphone
        : Camera;
  return (
    <div className={`feed ${source === "screen" ? "screen-feed" : ""}`}>
      <div className="feed-top">
        <span>
          <Icon size={15} />
          {sourceName[source]}
        </span>
        <span className={`feed-status ${stream ? "connected" : ""}`}>
          {stream ? (
            <>
              <i />
              {live ? "Live" : "Preview"}
            </>
          ) : (
            "Awaiting feed"
          )}
        </span>
      </div>
      {stream ? (
        <video ref={ref} muted playsInline autoPlay />
      ) : (
        <div className="feed-empty">
          <div className="feed-icon">
            <Icon size={28} strokeWidth={1.3} />
          </div>
          <p>
            {source === "screen"
              ? "A shared view. A clearer picture."
              : source === "desk-camera"
                ? "See the workspace from another angle."
                : "The candidate’s camera will appear here."}
          </p>
          <small>
            {source === "desk-camera"
              ? "Pair a phone to connect this view"
              : "Ready when the candidate connects"}
          </small>
        </div>
      )}
      {children}
    </div>
  );
}
export function ErrorNotice({ message }: { message?: string }) {
  return message ? (
    <div className="notice error" role="alert">
      {message}
    </div>
  ) : null;
}
