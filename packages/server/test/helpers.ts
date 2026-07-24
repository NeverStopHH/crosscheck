import { createDb, createServer } from "../src/index.ts";
import type { Db } from "../src/index.ts";

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
}

export const createTestHarness = async (
  options: TestHarnessOptions = {},
): Promise<TestHarness> => {
  const db = await createDb();
  const clock = createFakeClock();
  const adminToken =
    options.adminToken === undefined ? TEST_ADMIN_TOKEN : options.adminToken;
  const app = createServer({ db, now: clock.now, adminToken });
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