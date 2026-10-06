/**
 * THE SIMULATION'S HUB: the real server on an in-memory PGlite, behind a proxy
 * that injects the faults a scenario dials and logs every record the hub
 * answered — the ground truth for what was delivered, by whom, and how.
 *
 * Faults: a record POST answered 503 and never forwarded; one forwarded and
 * committed whose answer is lost (504 — a timeout the hub outlived); a
 * register answered 503; and a life whose work_context records the hub is made
 * to refuse for good (a blank title fails its schema). A process the hooks
 * killed reaches nothing.
 */
import { createDb, createServer } from "@crosscheck/server";
import type { Db } from "@crosscheck/server";

import { isDead } from "./sim-hooks.ts";

const ADMIN_TOKEN = "simulation-admin";
const HTTP_UNAVAILABLE = 503;
const HTTP_GATEWAY_TIMEOUT = 504;
const HTTP_CONFLICT = 409;
const HTTP_MULTIPLE_CHOICES = 300;

/** A fault on the next `count` calls of its kind, once `skip` of them went through. */
export interface Dial {
  skip: number;
  count: number;
}

export interface Dials {
  /** Record POSTs answered 503, never forwarded. */
  records503: Dial;
  /** Record POSTs forwarded and committed, their answer lost. */
  recordsLate: Dial;
  /** Register POSTs answered 503. */
  registersDown: Dial;
  /** Conversations (base life ids) whose work_context records the hub is made to refuse, every time. */
  readonly wcRefusedFor: Set<string>;
}

const idle = (): Dial => ({ skip: 0, count: 0 });

/** Whether this call is one the dial fails. */
const trips = (dial: Dial): boolean => {
  if (dial.count <= 0) {
    return false;
  }
  if (dial.skip > 0) {
    dial.skip -= 1;
    return false;
  }
  dial.count -= 1;
  return true;
};

/** The base life a session id is a life of: `cc_x~r2` → `cc_x`. */
const conversationOfLife = (sessionId: string): string => {
  const tilde = sessionId.indexOf("~");
  return tilde === -1 ? sessionId : sessionId.slice(0, tilde);
};

/** One record the hub answered for, as the proxy saw it. */
export interface Delivery {
  readonly id: string;
  readonly kind: string;
  /** The session it was delivered under — the envelope's producer as sent. */
  readonly producer: string;
  /** The session its body names, for the kinds the hub files by body. */
  readonly bodySession: string | null;
  readonly workContextId: string | null;
  readonly status: string;
  /** The body's session had ended on the hub before this request was forwarded. */
  readonly intoEndedSession: boolean;
  /**
   * ...and the connector had been TOLD so before it sent this: a 409 for that
   * session, a refusal saying it ended, or an end it sent itself. An end only
   * a sibling saw is one no flusher can know of (a documented residual).
   */
  readonly endKnown: boolean;
  /** The hub's answer never reached the connector (a 504 after the hub committed). */
  readonly answerLost: boolean;
  readonly step: number;
}

export interface SimHub {
  readonly url: string;
  /** The hub itself, past the proxy: what another process, invisible to the connector, talks to. */
  readonly directUrl: string;
  readonly apiKey: string;
  readonly developerId: string;
  readonly dials: Dials;
  readonly deliveries: Delivery[];
  /** Rows of the hub's own tables, read through PGlite directly. */
  readonly raw: <T>(text: string, params?: readonly unknown[]) => Promise<readonly T[]>;
  readonly db: Db;
  readonly clock: { step: number };
  readonly stop: () => Promise<void>;
}

interface WireRecord {
  readonly id?: unknown;
  readonly kind?: unknown;
  readonly producer?: { readonly sessionId?: unknown };
  readonly body?: {
    readonly sessionId?: unknown;
    readonly workContextId?: unknown;
    readonly id?: unknown;
    readonly title?: unknown;
  };
}

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** The session the hub files a record under by its body — target and work_context are what scenarios send. */
const bodySessionOf = (record: WireRecord): string | null => {
  if (record.kind === "work_context") {
    return text(record.body?.sessionId);
  }
  const workContextId = text(record.body?.workContextId);
  return record.kind === "target" && workContextId !== null && workContextId.startsWith("wc_")
    ? workContextId.slice("wc_".length)
    : null;
};

const workContextOf = (record: WireRecord): string | null =>
  record.kind === "work_context" ? text(record.body?.id) : text(record.body?.workContextId);

const unavailable = (message: string, status: number = HTTP_UNAVAILABLE): Response =>
  Response.json({ ok: false, error: { code: "unavailable", message } }, { status });

export const startSimHub = async (): Promise<SimHub> => {
  const db = await createDb();
  const client = (
    db as unknown as {
      $client: { query: (q: string, p: readonly unknown[]) => Promise<{ rows: unknown[] }>; close: () => Promise<void> };
    }
  ).$client;
  const raw = async <T>(sql: string, params: readonly unknown[] = []): Promise<readonly T[]> =>
    (await client.query(sql, params)).rows as T[];
  const server = Bun.serve({ port: 0, fetch: createServer({ db, adminToken: ADMIN_TOKEN }).fetch });
  const hubUrl = `http://127.0.0.1:${server.port}`;
  const dials: Dials = { records503: idle(), recordsLate: idle(), registersDown: idle(), wcRefusedFor: new Set() };
  const deliveries: Delivery[] = [];
  const clock = { step: 0 };
  /** Sessions the connector has been told are ended (Delivery.endKnown). */
  const toldEnded = new Set<string>();

  const forward = (request: Request, pathname: string, search: string, body: string | ArrayBuffer | undefined) =>
    fetch(`${hubUrl}${pathname}${search}`, { method: request.method, headers: request.headers, body });

  const endedOf = async (sessions: readonly string[]): Promise<ReadonlySet<string>> => {
    if (sessions.length === 0) {
      return new Set();
    }
    const rows = await raw<{ id: string }>("select id from agent_sessions where id = any($1) and ended_at is not null", [
      sessions,
    ]);
    return new Set(rows.map((row) => row.id));
  };

  const logAnswers = (
    wire: readonly WireRecord[],
    ended: ReadonlySet<string>,
    results: readonly { index: number; status: string; issues?: readonly string[] }[],
    answerLost: boolean,
  ) => {
    const known = new Set(toldEnded);
    for (const result of results) {
      const record = wire[result.index] ?? {};
      const bodySession = bodySessionOf(record);
      const producer = text(record.producer?.sessionId) ?? "";
      deliveries.push({
        id: text(record.id) ?? "",
        kind: text(record.kind) ?? "",
        producer,
        bodySession,
        workContextId: workContextOf(record),
        status: result.status,
        intoEndedSession: bodySession !== null && ended.has(bodySession),
        endKnown: bodySession !== null && known.has(bodySession),
        answerLost,
        step: clock.step,
      });
      if (!answerLost && result.status === "rejected" && /session has already ended/.test(result.issues?.[0] ?? "")) {
        toldEnded.add(producer);
      }
    }
  };

  /** A register answered 409 for a session, or an end the connector sent that landed: it knows that session ended. */
  const noteEnds = (method: string, pathname: string, body: ArrayBuffer | undefined, status: number): void => {
    if (method !== "POST") {
      return;
    }
    const end = /^\/api\/sessions\/([^/]+)\/end$/.exec(pathname);
    if (end?.[1] !== undefined && status < HTTP_MULTIPLE_CHOICES) {
      toldEnded.add(decodeURIComponent(end[1]));
    }
    if (pathname === "/api/sessions" && status === HTTP_CONFLICT && body !== undefined) {
      const id = (JSON.parse(new TextDecoder().decode(body)) as { id?: unknown }).id;
      if (typeof id === "string") {
        toldEnded.add(id);
      }
    }
  };

  const records = async (request: Request, pathname: string, search: string): Promise<Response> => {
    if (trips(dials.records503)) {
      return unavailable("sim 503");
    }
    const sent = (await request.json()) as { records?: WireRecord[] };
    const wire = (sent.records ?? []).map((record) =>
      record.kind === "work_context" && dials.wcRefusedFor.has(conversationOfLife(text(record.body?.sessionId) ?? ""))
        ? { ...record, body: { ...record.body, title: "" } }
        : record,
    );
    const ended = await endedOf(wire.map(bodySessionOf).filter((id): id is string => id !== null));
    const answer = await forward(request, pathname, search, JSON.stringify({ ...sent, records: wire }));
    const parsed = (await answer.clone().json()) as {
      data?: { results?: { index: number; status: string; issues?: string[] }[] };
    };
    const isLate = trips(dials.recordsLate);
    logAnswers(wire, ended, parsed.data?.results ?? [], isLate);
    return isLate ? unavailable("sim late", HTTP_GATEWAY_TIMEOUT) : answer;
  };

  const proxy = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const { pathname, search } = new URL(request.url);
      if (isDead()) {
        return unavailable("dead");
      }
      if (request.method === "POST" && pathname === "/api/records") {
        return records(request, pathname, search);
      }
      if (request.method === "POST" && pathname === "/api/sessions" && trips(dials.registersDown)) {
        return unavailable("sim 503");
      }
      const body = request.method === "GET" ? undefined : await request.arrayBuffer();
      const answer = await forward(request, pathname, search, body);
      noteEnds(request.method, pathname, body, answer.status);
      return answer;
    },
  });

  const made = await fetch(`${hubUrl}/api/developers`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Simulation", email: "simulation@example.com" }),
  });
  const developer = (await made.json()) as { data: { developer: { id: string }; apiKey: string } };

  return {
    url: `http://127.0.0.1:${proxy.port}`,
    directUrl: hubUrl,
    apiKey: developer.data.apiKey,
    developerId: developer.data.developer.id,
    dials,
    deliveries,
    raw,
    db,
    clock,
    stop: async () => {
      proxy.stop(true);
      server.stop(true);
      await client.close().catch(() => undefined);
    },
  };
};

/** The transient faults off; a work context the hub refuses for good stays refused. */
export const calmDials = (hub: SimHub): void => {
  hub.dials.records503 = idle();
  hub.dials.recordsLate = idle();
  hub.dials.registersDown = idle();
};

/** A scenario starts with every dial at rest and nothing logged. */
export const resetHub = (hub: SimHub): void => {
  calmDials(hub);
  hub.dials.wcRefusedFor.clear();
  hub.deliveries.length = 0;
  hub.clock.step = 0;
};
