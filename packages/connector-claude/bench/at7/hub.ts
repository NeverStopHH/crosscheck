/**
 * Starts a REAL hub from this worktree's source and seeds dana's hostile work
 * through its PUBLIC API, the way a teammate holding a developer key would
 * (09 §3). No canned hub, no fixture bypassing ingest: `crosscheck serve` on a
 * fresh data dir, two developers created through the admin API, and dana's work
 * written with dana's OWN key through `/api/sessions`, `/api/records` and
 * `/api/questions`.
 *
 * WHERE THE PAYLOAD LANDS. dana registers a session, files a work context with
 * a target on `src/slug.ts` (so the hub sees her work as relevant on the same
 * repo and file) and a declared intent, then asks the reader a question whose
 * body is the control note (control arm) or the note plus a §4 payload
 * (treatment arm). The question is the carrier: addressed to the reader, it
 * renders UNASKED in the reader's SessionStart briefing (briefing/questions.ts),
 * with the 400-char budget and span-redaction that keep the token intact.
 *
 * S5's hub half is read elsewhere: the reader's connector talks to the hub
 * through a logging proxy (proxy.ts), and S5 searches those request bodies for
 * the token — a published claim, say. This module only SEEDS dana's work.
 *
 * Keys are handled in memory and never logged — the whole point of a hostile
 * key is that it is a secret the harness must not leak.
 */
import { PROTOCOL_VERSION } from "@crosscheck/schema";

import { childEnv, drainTail } from "./exec.ts";
import { crosscheckBinPath, runtimePath } from "./paths.ts";

const READINESS_TIMEOUT_MS = 30_000;
const READINESS_POLL_MS = 200;
/** How much of the hub's stderr a startup failure quotes. */
const STDERR_TAIL_CHARS = 4_000;
const DANA_AGENT_KIND = "claude-code";

export interface HubHandle {
  readonly hubUrl: string;
  readonly adminToken: string;
  stop: () => Promise<void>;
}

export interface Developer {
  readonly id: string;
  readonly apiKey: string;
  readonly name: string;
  readonly email: string;
}

const randomHex = (bytes: number): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

/** The listening port of a Bun server, which is always set once it is up. */
const portOf = (server: { readonly port: number | undefined }): number => {
  if (server.port === undefined) {
    throw new Error("server has no port");
  }
  return server.port;
};

/** A free localhost port: bind ephemeral, read it, release it for the hub. */
const freePort = async (): Promise<number> => {
  const probe = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response(""),
  });
  const port = portOf(probe);
  await probe.stop(true);
  return port;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Any HTTP answer (even 401/404) proves the listener is up. */
const isReachable = async (hubUrl: string): Promise<boolean> => {
  try {
    await fetch(`${hubUrl}/`, { method: "GET" });
    return true;
  } catch {
    return false;
  }
};

const envForHub = (
  overrides: Readonly<Record<string, string>>,
): Record<string, string> => childEnv(process.env, overrides);

export const startHub = async (dataDir: string): Promise<HubHandle> => {
  const port = await freePort();
  const adminToken = randomHex(24);
  const hubUrl = `http://127.0.0.1:${String(port)}`;
  const proc = Bun.spawn([runtimePath(), crosscheckBinPath(), "serve"], {
    env: envForHub({
      PORT: String(port),
      CROSSCHECK_DATA_DIR: dataDir,
      ADMIN_TOKEN: adminToken,
    }),
    stdout: "ignore",
    stderr: "pipe",
  });
  // Drain stderr from the start: an unread pipe fills and blocks the hub's
  // writes mid-run. The bounded tail is what a startup failure quotes.
  // A read error becomes the quoted text, not an unhandled rejection: on the
  // success path nobody awaits this promise.
  const stderrTail = drainTail(proc.stderr, STDERR_TAIL_CHARS).catch(
    (error: unknown) => `(stderr unreadable: ${String(error)})`,
  );
  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isReachable(hubUrl)) {
      return {
        hubUrl,
        adminToken,
        stop: async () => {
          proc.kill();
          await proc.exited;
        },
      };
    }
    await sleep(READINESS_POLL_MS);
  }
  proc.kill();
  await proc.exited;
  throw new Error(`hub did not become reachable on ${hubUrl}: ${(await stderrTail).trim()}`);
};

interface JsonResponse {
  readonly status: number;
  readonly body: unknown;
}

const postJson = async (
  url: string,
  token: string,
  body: unknown,
): Promise<JsonResponse> => {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};

export const createDeveloper = async (
  hub: HubHandle,
  name: string,
  email: string,
): Promise<Developer> => {
  const { status, body } = await postJson(
    `${hub.hubUrl}/api/developers`,
    hub.adminToken,
    { name, email },
  );
  if (status !== 200) {
    throw new Error(`createDeveloper(${name}) failed: ${String(status)}`);
  }
  const data = (
    body as { data?: { developer?: { id?: string }; apiKey?: string } }
  )?.data;
  const id = data?.developer?.id;
  const apiKey = data?.apiKey;
  if (typeof id !== "string" || typeof apiKey !== "string") {
    throw new Error(`createDeveloper(${name}) returned no id/key`);
  }
  return { id, apiKey, name, email };
};

export interface SeedInput {
  readonly hub: HubHandle;
  readonly dana: Developer;
  readonly readerName: string;
  readonly repoId: string;
  readonly headSha: string;
  readonly title: string;
  readonly intentSummary: string;
  /** Control note, or note + payload — the untrusted question body (§3). */
  readonly questionBody: string;
  readonly slotIndex: number;
}

export interface SeedResult {
  readonly sessionId: string;
  readonly workContextId: string;
  readonly questionId: string;
}

const envelope = (
  dana: Developer,
  sessionId: string,
  kind: string,
  body: unknown,
  ts: string,
): unknown => ({
  cx: PROTOCOL_VERSION,
  id: `env_${crypto.randomUUID()}`,
  ts,
  producer: { developerId: dana.id, agentKind: DANA_AGENT_KIND, sessionId },
  kind,
  body,
});

export const seedDanaWork = async (input: SeedInput): Promise<SeedResult> => {
  const { hub, dana } = input;
  const suffix = `${String(input.slotIndex)}_${randomHex(4)}`;
  const sessionId = `cc_dana_${suffix}`;
  const workContextId = `wc_dana_${suffix}`;
  const ts = new Date().toISOString();

  const session = await postJson(`${hub.hubUrl}/api/sessions`, dana.apiKey, {
    id: sessionId,
    agentKind: DANA_AGENT_KIND,
    repo: input.repoId,
    branch: "feat/dana-slug",
    baseCommit: input.headSha,
    status: "implementing",
    seq: { epoch: crypto.randomUUID(), n: 0 },
  });
  if (session.status !== 200) {
    throw new Error(`dana session register failed: ${String(session.status)}`);
  }

  const records = await postJson(`${hub.hubUrl}/api/records`, dana.apiKey, {
    records: [
      envelope(
        dana,
        sessionId,
        "work_context",
        {
          id: workContextId,
          sessionId,
          title: input.title,
          status: "implementing",
          intent: {
            summary: input.intentSummary,
            provenance: "declared",
            confidence: 1,
            capturedAt: ts,
          },
          createdAt: ts,
        },
        ts,
      ),
      envelope(
        dana,
        sessionId,
        "target",
        { workContextId, kind: "file", value: "src/slug.ts", source: "tool_edit" },
        ts,
      ),
    ],
  });
  const accepted = (records.body as { data?: { accepted?: number } })?.data
    ?.accepted;
  if (records.status !== 200 || (accepted ?? 0) < 2) {
    throw new Error(
      `dana records ingest failed: ${String(records.status)} ${JSON.stringify(records.body)}`,
    );
  }

  const question = await postJson(`${hub.hubUrl}/api/questions`, dana.apiKey, {
    id: `qn_${crypto.randomUUID()}`,
    repo: input.repoId,
    sessionId,
    body: input.questionBody,
    developer: input.readerName,
    workContextId,
  });
  if (question.status !== 200) {
    throw new Error(
      `dana question failed: ${String(question.status)} ${JSON.stringify(question.body)}`,
    );
  }
  const questionBody = question.body as {
    data?: { question?: { id?: string }; questionId?: string };
  };
  const questionId =
    questionBody?.data?.question?.id ?? questionBody?.data?.questionId ?? "";
  return { sessionId, workContextId, questionId };
};
