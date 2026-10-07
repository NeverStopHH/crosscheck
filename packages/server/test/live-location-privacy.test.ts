/**
 * THE LIVE-LOCATION POLICY, held over EVERY route the hub serves — GET and
 * POST, with each route's own variants (test/live-location-routes.ts).
 *
 * Opt-out withholds a developer's live location — branch, commits, session
 * start, heartbeat and update instants, fallback titles — from every
 * structured field every hub route serves, and from presence
 * (services/visibility.ts states it, and what it does not hide).
 *
 * WHAT MAKES IT ABLE TO FAIL, each one a way an earlier guard passed while
 * a review found leaks:
 *   - the route list is the APP's, and a route the table does not name fails
 *     the walk — a new GET or POST cannot pass by being unknown
 *   - every route is walked with its OWN variants, and a route whose handler
 *     READS a query or body parameter no variant supplies fails: the
 *     parameters are recorded off the request as the handler asks for them
 *     (review round 4, H5: a branch behind a new ?verbose=1 passed)
 *   - the secrets are every spelling of her location: both branches, both
 *     HEADs whole and by every prefix 7–12, and every instant of hers in ANY
 *     spelling within a minute — ISO, Postgres text, minute precision,
 *     epoch, "N min ago", an idleSeconds-style age (opted-out-world.ts
 *     leaksIn) — in the body AND the headers
 *   - the stream is read for its whole window, with an event of hers inside it
 *   - a route promised to show her row must show it (withheld), and a route
 *     that shows none must say why; her OWN view is checked route by route
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { HonoRequest } from "hono/request";
import { LOCATION_WITHHELD, WITHHELD_TITLE } from "@crosscheck/schema";

// The CONNECTOR's own rule for "solved", for the parity check below — a
// test-only import: the hub package does not depend on the connector.
import { solvedAtFromTree } from "../../connector-core/src/mcp/render.ts";
import { listSolvedInfo } from "../src/services/solved.ts";
import { jsonRequest } from "./helpers.ts";
import { ROUTES } from "./live-location-routes.ts";
import type { RouteSpec } from "./live-location-routes.ts";
import { ROBIN_ROW, appRoutes, concretePath, label, patternOf, walk } from "./live-location-walk.ts";
import type { Answer } from "./live-location-walk.ts";
import {
  ROBIN_CONTEXT,
  ROBIN_DETACHED_CONTEXT,
  ROBIN_HOST_CONTEXT,
  ROBIN_LOCAL_CONTEXT,
  ROBIN_SOLVED,
  leaksIn,
  secretsIn,
  seedOptedOutWorld,
} from "./opted-out-world.ts";
import type { OptedOutWorld } from "./opted-out-world.ts";

const ROBIN_CONTEXT_IDS: readonly string[] = [ROBIN_CONTEXT, ROBIN_SOLVED, ROBIN_LOCAL_CONTEXT, ROBIN_DETACHED_CONTEXT, ROBIN_HOST_CONTEXT];

const HTTP_OK_MIN = 200;
const HTTP_OK_MAX = 299;
const HTTP_CLIENT_ERROR_MIN = 400;
const HTTP_CLIENT_ERROR_MAX = 499;

const inRange = (status: number, min: number, max: number): boolean => status >= min && status <= max;

const statusProblem = (spec: RouteSpec, answer: Answer): readonly string[] => {
  if (answer.variant.refused !== undefined) {
    return inRange(answer.status, HTTP_CLIENT_ERROR_MIN, HTTP_CLIENT_ERROR_MAX)
      ? []
      : [`${label(answer)}: answered ${String(answer.status)}, expected a refusal (${answer.variant.refused})`];
  }
  if (spec.status !== undefined) {
    return answer.status === spec.status.code
      ? []
      : [`${label(answer)}: answered ${String(answer.status)}, expected ${String(spec.status.code)} (${spec.status.why})`];
  }
  return inRange(answer.status, HTTP_OK_MIN, HTTP_OK_MAX)
    ? []
    : [`${label(answer)}: answered ${String(answer.status)} — never reached its data`];
};

const byRoute = (answers: readonly Answer[]): ReadonlyMap<string, readonly Answer[]> => {
  const grouped = new Map<string, readonly Answer[]>();
  for (const answer of answers) {
    grouped.set(answer.key, [...(grouped.get(answer.key) ?? []), answer]);
  }
  return grouped;
};

const colleagueProblems = (key: string, spec: RouteSpec, answers: readonly Answer[]): readonly string[] => {
  const showsHer = answers.some((answer) => answer.variant.refused === undefined && ROBIN_ROW.test(answer.body));
  if (spec.colleague === "withheld") {
    return showsHer ? [] : [`${key}: promised to show Robin's row withheld, and no variant shows it`];
  }
  return showsHer ? [`${key}: shows Robin's row, but the table says it does not (${spec.colleague.hidden})`] : [];
};

/**
 * THE PARAMETERS A HANDLER READS, recorded as it reads them: a query name it
 * asks for, a body key its schema looks up. Recorded per route while the
 * walk calls it, so the table is checked against what the code accepts
 * rather than against what somebody remembered to write down.
 */
interface ParameterLog {
  readonly query: Set<string>;
  readonly body: Set<string>;
}

const parameterLogs = new Map<string, ParameterLog>();
let currentRoute: string | null = null;

/**
 * The current route's log — and only for a request to THAT route: a
 * stream's `during` writes through other routes while it is read.
 */
const logOf = (path?: string): ParameterLog | undefined => {
  if (currentRoute === null || (path !== undefined && !patternOf(currentRoute).test(path))) {
    return undefined;
  }
  const log = parameterLogs.get(currentRoute) ?? { query: new Set<string>(), body: new Set<string>() };
  parameterLogs.set(currentRoute, log);
  return log;
};

/** Keys any reader looks up on any object — thenables, coercions — never parameters. */
const NOT_PARAMETERS: ReadonlySet<string> = new Set(["then", "toJSON", "constructor", "valueOf", "toString"]);

const recordingKeys = (value: unknown, into: (key: string) => void): unknown =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? new Proxy(value, {
        get: (target, key, receiver) => {
          if (typeof key === "string" && !NOT_PARAMETERS.has(key)) {
            into(key);
          }
          return Reflect.get(target, key, receiver);
        },
        has: (target, key) => {
          if (typeof key === "string") {
            into(key);
          }
          return Reflect.has(target, key);
        },
      })
    : value;

interface RequestMethods {
  query: (this: HonoRequest, key?: string) => unknown;
  queries: (this: HonoRequest, key?: string) => unknown;
  json: (this: HonoRequest) => Promise<unknown>;
  parseBody: (this: HonoRequest, ...args: readonly unknown[]) => Promise<unknown>;
}

const requestProto = HonoRequest.prototype as unknown as RequestMethods;
const originals: RequestMethods = {
  query: requestProto.query,
  queries: requestProto.queries,
  json: requestProto.json,
  parseBody: requestProto.parseBody,
};

const originalFromEntries = Object.fromEntries;

const installRecorder = (): void => {
  requestProto.query = function (this: HonoRequest, key?: string) {
    if (key !== undefined) {
      logOf(this.path)?.query.add(key);
    }
    return originals.query.call(this, key);
  };
  requestProto.queries = function (this: HonoRequest, key?: string) {
    if (key !== undefined) {
      logOf(this.path)?.query.add(key);
    }
    return originals.queries.call(this, key);
  };
  requestProto.json = async function (this: HonoRequest) {
    const path = this.path;
    return recordingKeys(await originals.json.call(this), (key) => logOf(path)?.body.add(key));
  };
  requestProto.parseBody = async function (this: HonoRequest, ...args: readonly unknown[]) {
    const path = this.path;
    return recordingKeys(await originals.parseBody.call(this, ...args), (key) => logOf(path)?.body.add(key));
  };
  // A handler that hands its WHOLE query to a schema (GET /api/waiver-requests,
  // GET /api/fence-waivers) asks for no name; the schema's own lookups on the
  // object are what it accepts, so they are recorded the same way.
  Object.fromEntries = ((entries: Iterable<readonly [PropertyKey, unknown]>) => {
    const built = originalFromEntries(entries);
    return entries instanceof URLSearchParams
      ? (recordingKeys(built, (key) => logOf()?.query.add(key)) as typeof built)
      : built;
  }) as typeof Object.fromEntries;
};

const removeRecorder = (): void => {
  Object.assign(requestProto, originals);
  Object.fromEntries = originalFromEntries;
};

/** The parameters a route's variants supply, per kind. */
const exercised = (spec: RouteSpec): ParameterLog => ({
  query: new Set(spec.variants.flatMap((variant) => Object.keys(variant.query ?? {}))),
  body: new Set(
    spec.variants.flatMap((variant) =>
      typeof variant.body === "object" && variant.body !== null ? Object.keys(variant.body) : [],
    ),
  ),
});

const unexercisedProblems = (key: string, spec: RouteSpec): readonly string[] => {
  const read = parameterLogs.get(key);
  if (read === undefined) {
    return [];
  }
  const supplied = exercised(spec);
  const reasons = spec.unexercised ?? {};
  return [
    ...[...read.query]
      .filter((name) => !supplied.query.has(name) && reasons[`?${name}`] === undefined)
      .map((name) => `${key}: reads ?${name}, which no variant supplies`),
    ...[...read.body]
      .filter((name) => !supplied.body.has(name) && reasons[name] === undefined)
      .map((name) => `${key}: reads body.${name}, which no variant supplies`),
  ];
};

beforeAll(installRecorder);
afterAll(removeRecorder);

/**
 * SOLVED PARITY (review round 5, H2): a withheld field must never flip a
 * conclusion. The connector decides "solved" from the diagnosis it is handed
 * (connector-core mcp/render.ts solvedAtFromTree — evidence refs, status,
 * edges); the hub decides it from its own rows (services/solved.ts). Round 4
 * dropped evidence refs that looked like commits, so the connector said
 * open where the hub said solved. Checked for every context of hers, in the
 * opted-out world and with her opted back in.
 */
describe("the hub and the connector agree which of her trees are solved", () => {
  const solvedBoth = async (world: OptedOutWorld): Promise<readonly string[]> => {
    const hub = await listSolvedInfo(world.harness.db, ROBIN_CONTEXT_IDS);
    return Promise.all(
      ROBIN_CONTEXT_IDS.map(async (id) => {
        const response = await world.harness.app.request(`/api/work-contexts/${id}/diagnosis?telemetry=0`, {
          headers: { Authorization: `Bearer ${world.nick.apiKey}` },
        });
        const diagnosis = ((await response.json()) as { data: Parameters<typeof solvedAtFromTree>[0] }).data;
        return `${id}: hub ${hub.has(id) ? "solved" : "open"}, connector ${solvedAtFromTree(diagnosis) === null ? "open" : "solved"}`;
      }),
    );
  };
  const agree = (line: string): boolean => /hub (\w+), connector \1$/.test(line);

  test("in the opted-out world, and with her opted back in", async () => {
    const world = await seedOptedOutWorld();
    const optedOut = await solvedBoth(world);
    const back = await world.harness.app.request("/api/settings/presence", jsonRequest("PUT", world.robin.apiKey, { optOut: false }));
    expect(back.status).toBe(200);
    const optedIn = await solvedBoth(world);

    expect([...optedOut, ...optedIn].filter((line) => !agree(line))).toEqual([]);
    expect(optedOut.some((line) => line.includes("hub solved"))).toBe(true);
  });
});

describe("the route table", () => {
  test("names exactly the routes the app registers, each with variants or a written reason", async () => {
    const world = await seedOptedOutWorld();
    const registered = appRoutes(world);

    const unknown = registered.filter((key) => ROUTES[key] === undefined).map((key) => `${key}: not in the table`);
    const stale = Object.keys(ROUTES).filter((key) => !registered.includes(key)).map((key) => `${key}: not registered`);
    const unreasoned = Object.entries(ROUTES).flatMap(([key, spec]) => {
      const reaching = spec.variants.filter((variant) => variant.refused === undefined);
      return reaching.length === 0 && spec.whyNoVariants === undefined && spec.notCalled === undefined
        ? [`${key}: no variant reaches its data and no reason says why`]
        : [];
    });
    const misfiled = Object.entries(ROUTES).flatMap(([key, spec]) =>
      spec.variants
        .filter((variant) => !patternOf(key).test(concretePath(world, variant)))
        .map((variant) => `${key}: variant ${variant.path} is not this route`),
    );

    expect([...unknown, ...stale, ...unreasoned, ...misfiled]).toEqual([]);
    expect(registered.length).toBeGreaterThan(80);
  });
});

describe("an opted-out developer's live location reaches no other viewer, on any route", () => {
  test("Nick reads no location of Robin's in any variant of any route, and sees her rows where promised", async () => {
    const world = await seedOptedOutWorld();
    const now = world.harness.clock.now();

    const answers = await walk(world, "nick", (key) => {
      currentRoute = key;
    });
    currentRoute = null;

    // Every problem at once, so one run names every route that needs work.
    const problems = [
      ...answers.flatMap((answer) => [
        ...statusProblem(ROUTES[answer.key] as RouteSpec, answer),
        ...leaksIn(answer.body, now).map((secret) => `${label(answer)}: leaks her ${secret}`),
        ...leaksIn(answer.headers, now).map((secret) => `${label(answer)}: leaks her ${secret} in a header`),
      ]),
      ...[...byRoute(answers)].flatMap(([key, routeAnswers]) =>
        colleagueProblems(key, ROUTES[key] as RouteSpec, routeAnswers),
      ),
      ...Object.entries(ROUTES).flatMap(([key, spec]) => unexercisedProblems(key, spec)),
    ];
    expect(problems).toEqual([]);
  }, 120_000);

  test("Robin's own reads show her location route by route, and never in withheld form", async () => {
    const world = await seedOptedOutWorld();

    const answers = await walk(world, "robin");

    const problems = [
      ...answers
        .filter((answer) => answer.body.includes(WITHHELD_TITLE) || answer.body.includes(LOCATION_WITHHELD))
        .map((answer) => `${label(answer)}: her own view is withheld from her`),
      ...[...byRoute(answers)].flatMap(([key, routeAnswers]) =>
        (ROUTES[key] as RouteSpec).self === "located" && !routeAnswers.some((answer) => secretsIn(answer.body).length > 0)
          ? [`${key}: promised to show Robin her own location, and no variant does`]
          : [],
      ),
    ];
    expect(problems).toEqual([]);
  }, 120_000);
});
