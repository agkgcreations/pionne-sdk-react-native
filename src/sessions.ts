// Release Health — session manager.
//
// One session = one user-perceived "run" of the app. We open it at init()
// with status='ok', flip to 'crashed' if the global error handler sees a
// fatal, and (best-effort) close it with 'exited' on AppState=background.
//
// The backend keys upserts on (project_id, session_id), so we can post the
// same UUID multiple times safely. We send minimal traffic: one POST at
// open, one POST at flip.

import type { PionneEvent } from './types';

export type SessionStatus = 'ok' | 'crashed' | 'errored' | 'abnormal' | 'exited';

export interface SessionContext {
  endpoint: string;          // base API URL — '/sessions' is appended
  token: string;
  release?: string;
  environment?: string;
  appVersion?: string;
  osName?: string;
  userIdAnon?: string;
  appId?: string;
}

interface SessionState {
  id: string;
  startedAt: number;
  status: SessionStatus;
  ctx: SessionContext;
}

let current: SessionState | null = null;

// RFC4122 v4-ish UUID generator. We can't pull `crypto.randomUUID()` here
// because Hermes < 0.74 lacks it, and we don't want a polyfill dependency.
function uuid(): string {
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  const bytes = new Array(16).fill(0).map(() => Math.floor(Math.random() * 256));
  // Set version (4) and variant (RFC4122) bits per spec.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = bytes.map(hex).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Derive the /sessions endpoint from the user-supplied /ingest endpoint.
// Both share the same /api root, so a string-replace is enough.
function sessionsUrl(ingestEndpoint: string): string {
  if (ingestEndpoint.endsWith('/ingest')) {
    return ingestEndpoint.slice(0, -'/ingest'.length) + '/sessions';
  }
  // Fallback: assume the user passed the API root directly.
  return ingestEndpoint.replace(/\/+$/, '') + '/sessions';
}

function postSession(state: SessionState, status: SessionStatus, durationMs?: number): void {
  const url = sessionsUrl(state.ctx.endpoint);
  const body = {
    session_id: state.id,
    status,
    release: state.ctx.release,
    environment: state.ctx.environment,
    app_version: state.ctx.appVersion,
    os_name: state.ctx.osName,
    user_id_anon: state.ctx.userIdAnon,
    app_id: state.ctx.appId,
    duration_ms: durationMs,
  };
  // Strip undefined keys to avoid sending nulls the validator rejects.
  for (const k of Object.keys(body) as (keyof typeof body)[]) {
    if (body[k] === undefined) delete body[k];
  }
  // Fire-and-forget — sessions are best-effort observability data.
  fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Pionne-Token': state.ctx.token,
    },
    body: JSON.stringify(body),
  }).catch(() => undefined);
}

export function startSession(ctx: SessionContext): string {
  current = {
    id: uuid(),
    startedAt: Date.now(),
    status: 'ok',
    ctx,
  };
  postSession(current, 'ok');
  return current.id;
}

export function flipSession(status: SessionStatus): void {
  if (!current) return;
  // Local precedence: don't demote a 'crashed' session.
  const rank: Record<SessionStatus, number> =
    { ok: 0, exited: 1, errored: 2, abnormal: 3, crashed: 4 };
  if (rank[status] <= rank[current.status]) return;
  current.status = status;
  postSession(current, status, Date.now() - current.startedAt);
}

export function endSession(status: SessionStatus = 'exited'): void {
  if (!current) return;
  flipSession(status);
  current = null;
}

export function getCurrentSessionId(): string | null {
  return current?.id ?? null;
}

// Helper for the global error handler — flips on fatal/error events.
export function flipFromEvent(event: Pick<PionneEvent, 'level' | 'mechanism'>): void {
  // Only auto-flip on uncaught/unhandled — manual `captureException` doesn't
  // mean the app is in a bad state.
  if (event.mechanism?.type === 'manual') return;
  if (event.level === 'fatal') flipSession('crashed');
  else if (event.level === 'error') flipSession('errored');
}
