import { createDb, createServer } from "../src/index.ts";
import type { Db, Embedder } from "../src/index.ts";

export const TEST_ADMIN_TOKEN = "test-admin-token";
export const TEST_START_ISO = "2026-07-24T09:00:00.000Z";

const MS_PER_SECOND = 1000;

export interface FakeClock {
  readonly now: () => Date;
  readonly advanceSeconds: (seconds: number) => void;
}

export const createFakeClock = (startIso: string = TEST_START_ISO): FakeClock => {
  let currentMs = new Date(startIso).getTime();
  return {
    now: () => new Date(currentMs),
    advanceSeconds: (seconds: number) => {
      currentMs += seconds * MS_PER_SECOND;
    },
  };
};

export interface TestHarness {
  readonly app: ReturnType<typeof createServer>;
  readonly clock: FakeClock;
  readonly db: Db;
}

export interface TestHarnessOptions {
  readonly adminToken?: string | null;
  /** Omitted = keyless harness, the default install (DESIGN.md §6). */
  readonly embedder?: Embedder | null;
}

export const createTestHarness = async (
  options: TestHarnessOptions = {},
): Promise<TestHarness> => {
  const db = await createDb();
  const clock = createFakeClock();
  const adminToken =
    options.adminToken === undefined ? TEST_ADMIN_TOKEN : options.adminToken;
  const app = createServer({
    db,
    now: clock.now,
    adminToken,
    embedder: options.embedder ?? null,
  });
  return { app, clock, db };
};

export const jsonRequest = (
  method: string,
  apiKey: string | null,
  body?: unknown,
): RequestInit => ({
  method,
  headers: {
    "Content-Type": "application/json",
    ...(apiKey === null ? {} : { Authorization: `Bearer ${apiKey}` }),
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

export interface TestDeveloper {
  readonly developerId: string;
  readonly apiKey: string;
}

export const createTestDeveloper = async (
  harness: TestHarness,
  name: string,
  email: string,
): Promise<TestDeveloper> => {
  const response = await harness.app.request(
    "/api/developers",
    jsonRequest("POST", TEST_ADMIN_TOKEN, { name, email }),
  );
  if (response.status !== 200) {
    throw new Error(`developer bootstrap failed with status ${response.status}`);
  }
  const body = (await response.json()) as {
    data: { developer: { id: string }; apiKey: string };
  };
  return { developerId: body.data.developer.id, apiKey: body.data.apiKey };
};

export const VALID_SESSION_BODY = {
  id: "ses_01",
  agentKind: "claude-code",
  repo: "github.com/acme/api",
  branch: "feat/entity-mapping",
  baseCommit: "a1b2c3d4",
  status: "analyzing",
} as const;

export const registerTestSession = async (
  harness: TestHarness,
  apiKey: string,
  overrides: Record<string, unknown> = {},
): Promise<Response> =>
  harness.app.request(
    "/api/sessions",
    jsonRequest("POST", apiKey, { ...VALID_SESSION_BODY, ...overrides }),
  );

export interface PresenceSessionView {
  readonly sessionId: string;
  readonly developerId: string;
  readonly developerName: string;
  readonly agentKind: string;
  readonly repo: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly status: string;
  readonly startedAt: string;
  readonly lastHeartbeatAt: string;
  readonly isSelf: boolean;
}

export const fetchPresence = async (
  harness: TestHarness,
  apiKey: string,
  repo: string = VALID_SESSION_BODY.repo,
): Promise<{ status: number; sessions: PresenceSessionView[] }> => {
  const response = await harness.app.request(
    `/api/presence?repo=${encodeURIComponent(repo)}`,
    jsonRequest("GET", apiKey),
  );
  if (response.status !== 200) {
    return { status: response.status, sessions: [] };
  }
  const body = (await response.json()) as {
    data: { sessions: PresenceSessionView[] };
  };
  return { status: response.status, sessions: body.data.sessions };
};

export interface EventView {
  readonly id: number;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
  readonly createdAt: string;
}

export const CX_VERSION = "0.1";
export const WORK_CONTEXT_ID = "wc_01";

/** Sentinel that postRecords swaps for the posting developer's real id. */
export const PLACEHOLDER_DEVELOPER_ID = "dev_producer";

export interface EnvelopeOverrides {
  readonly id?: string;
  readonly ts?: string;
  readonly sessionId?: string;
  readonly developerId?: string;
}

export const recordEnvelope = (
  kind: string,
  body: unknown,
  overrides: EnvelopeOverrides = {},
): Record<string, unknown> => ({
  cx: CX_VERSION,
  id: overrides.id ?? `env_${crypto.randomUUID()}`,
  ts: overrides.ts ?? TEST_START_ISO,
  producer: {
    developerId: overrides.developerId ?? PLACEHOLDER_DEVELOPER_ID,
    agentKind: "claude-code",
    sessionId: overrides.sessionId ?? VALID_SESSION_BODY.id,
  },
  kind,
  body,
});

export const validWorkContextBody = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id: WORK_CONTEXT_ID,
  sessionId: VALID_SESSION_BODY.id,
  title: "Login 500s on staging",
  description: "POST /login returns 500 after token refresh",
  status: "analyzing",
  createdAt: TEST_START_ISO,
  ...overrides,
});

export const validClaimBody = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id: "clm_01",
  workContextId: WORK_CONTEXT_ID,
  authorSessionId: VALID_SESSION_BODY.id,
  kind: "observation",
  body: "JWT validation fails after token refresh",
  status: "proposed",
  confidence: 0.8,
  captureMode: "agent",
  provenance: "declared",
  evidenceRefs: [],
  createdAt: TEST_START_ISO,
  ...overrides,
});

export const validClaimEdgeBody = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id: "edge_01",
  fromClaimId: "clm_02",
  toClaimId: "clm_01",
  kind: "supports",
  authorSessionId: VALID_SESSION_BODY.id,
  createdAt: TEST_START_ISO,
  ...overrides,
});

export interface RecordResultView {
  readonly index: number;
  readonly status: string;
  readonly id?: string;
  readonly issues?: string[];
}

export interface IngestResponseData {
  readonly results: RecordResultView[];
  readonly accepted: number;
  readonly duplicates: number;
  readonly ignored: number;
  readonly rejected: number;
}

const withRealProducer = (record: unknown, developerId: string): unknown => {
  if (typeof record !== "object" || record === null) {
    return record;
  }
  const envelope = record as Record<string, unknown>;
  const producer = envelope["producer"];
  if (typeof producer !== "object" || producer === null) {
    return record;
  }
  const producerObj = producer as Record<string, unknown>;
  if (producerObj["developerId"] !== PLACEHOLDER_DEVELOPER_ID) {
    return record;
  }
  return { ...envelope, producer: { ...producerObj, developerId } };
};

const resolveProducerIds = (body: unknown, developerId: string): unknown => {
  if (typeof body !== "object" || body === null) {
    return body;
  }
  const container = body as Record<string, unknown>;
  if (Array.isArray(container["records"])) {
    return {
      ...container,
      records: container["records"].map((record) =>
        withRealProducer(record, developerId),
      ),
    };
  }
  return withRealProducer(body, developerId);
};

export const postRecords = async (
  harness: TestHarness,
  developer: TestDeveloper | null,
  body: unknown,
): Promise<{ status: number; data: IngestResponseData | null }> => {
  const resolvedBody =
    developer === null ? body : resolveProducerIds(body, developer.developerId);
  const response = await harness.app.request(
    "/api/records",
    jsonRequest("POST", developer?.apiKey ?? null, resolvedBody),
  );
  if (response.status !== 200) {
    return { status: response.status, data: null };
  }
  const json = (await response.json()) as { data: IngestResponseData };
  return { status: response.status, data: json.data };
};

export interface HarnessWithSession {
  readonly harness: TestHarness;
  readonly developer: TestDeveloper;
}

export const createHarnessWithSession = async (
  sessionOverrides: Record<string, unknown> = {},
): Promise<HarnessWithSession> => {
  const harness = await createTestHarness();
  const developer = await createTestDeveloper(harness, "Nick", "nick@example.com");
  await registerTestSession(harness, developer.apiKey, sessionOverrides);
  return { harness, developer };
};

/** Adds a second developer with an own registered session to a harness. */
export const addTestDeveloperWithSession = async (
  harness: TestHarness,
  name: string,
  email: string,
  sessionOverrides: Record<string, unknown> = {},
): Promise<TestDeveloper> => {
  const developer = await createTestDeveloper(harness, name, email);
  await registerTestSession(harness, developer.apiKey, sessionOverrides);
  return developer;
};

export const fetchEvents = async (
  harness: TestHarness,
  apiKey: string,
  query: string = "",
): Promise<EventView[]> => {
  const response = await harness.app.request(
    `/api/events${query}`,
    jsonRequest("GET", apiKey),
  );
  if (response.status !== 200) {
    throw new Error(`fetching events failed with status ${response.status}`);
  }
  const body = (await response.json()) as { data: { events: EventView[] } };
  return body.data.events;
};