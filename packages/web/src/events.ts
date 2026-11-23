// The server's events (DESIGN §9.4), over a WebSocket to /api/events on this page's origin,
// signed in by the session cookie. Reconnects after a drop, waiting longer each time; there's
// no replay, so whoever listens reads again what it needs once reconnected.

import type { BranchInfo, CommitInfo, TaskInfo } from "./api.ts";

export type EventMessage =
  | { type: "hello"; login: string; role: string; branches: string[]; at: string }
  | { type: "head"; branch: string; commit: CommitInfo; by: string; at: string }
  | { type: "branch"; branch: BranchInfo; change: "created" | "discarded"; by: string | null; at: string }
  | { type: "task"; task: TaskInfo; change: string; by: string | null; at: string }
  | { type: "validation"; branch: string; commit: string; task?: number; errors: number; warnings: number; at: string };

/** The socket was closed because the sign-in stopped working. */
const SIGNED_OUT = 4401;

export interface EventsHandlers {
  message(m: EventMessage): void;
  /** Connected again after a drop: read what may have changed. */
  reconnected?(): void;
  signedOut?(): void;
}

/** Listen until the returned function is called. */
export function listen(h: EventsHandlers): () => void {
  let ws: WebSocket | null = null;
  let stopped = false;
  let wait = 500;
  let opened = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const connect = () => {
    const url = new URL("/api/events", location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(url);
    ws.onopen = () => {
      if (opened) h.reconnected?.();
      opened = true;
      wait = 500;
    };
    ws.onmessage = (e) => {
      try {
        h.message(JSON.parse(String(e.data)) as EventMessage);
      } catch {
        // not ours
      }
    };
    ws.onclose = (e) => {
      ws = null;
      if (stopped) return;
      if (e.code === SIGNED_OUT) return h.signedOut?.();
      timer = setTimeout(connect, wait);
      wait = Math.min(wait * 2, 15_000);
    };
  };
  connect();
  return () => {
    stopped = true;
    clearTimeout(timer);
    ws?.close();
  };
}
