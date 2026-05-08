// User Feedback — programmatic API used by the Modal and by power users
// who want to roll their own UI. Posts to /events/{id}/feedback when an
// eventId is known (e.g. right after a Pionne.captureException), or to
// /feedback for standalone reports.

export interface FeedbackContext {
  endpoint: string; // base API URL — derived from the SDK config
  token: string;
  appVersion?: string;
}

export interface FeedbackPayload {
  message: string;
  name?: string;
  email?: string;
  eventId?: number | string;
  url?: string;
}

function feedbackUrl(ingestEndpoint: string, eventId?: number | string): string {
  const base = ingestEndpoint.endsWith('/ingest')
    ? ingestEndpoint.slice(0, -'/ingest'.length)
    : ingestEndpoint.replace(/\/+$/, '');
  return eventId
    ? `${base}/events/${encodeURIComponent(String(eventId))}/feedback`
    : `${base}/feedback`;
}

export async function sendFeedback(
  ctx: FeedbackContext,
  payload: FeedbackPayload,
): Promise<{ ok: boolean; status: number }> {
  if (!payload?.message?.trim()) {
    return { ok: false, status: 0 };
  }
  const url = feedbackUrl(ctx.endpoint, payload.eventId);
  const body: Record<string, unknown> = {
    message: payload.message.trim(),
    name: payload.name?.trim() || undefined,
    email: payload.email?.trim() || undefined,
    url: payload.url,
    app_version: ctx.appVersion,
  };
  for (const k of Object.keys(body)) {
    if (body[k] === undefined) delete body[k];
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Pionne-Token': ctx.token,
      },
      body: JSON.stringify(body),
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

// ─── Internal event bus for the Modal ───────────────────────────────────
// `Pionne.showFeedback()` emits an event the <PionneFeedbackModal/> listens
// to. We use a tiny in-process emitter so the SDK has zero RN/EventEmitter
// dependency.

type ShowOpts = { eventId?: number | string; defaults?: Partial<FeedbackPayload> };
type Listener = (opts: ShowOpts) => void;
const listeners = new Set<Listener>();

export function emitShowFeedback(opts: ShowOpts): void {
  for (const l of listeners) {
    try { l(opts); } catch { /* ignore listener errors */ }
  }
}

export function onShowFeedback(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
