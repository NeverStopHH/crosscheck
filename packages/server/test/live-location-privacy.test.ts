/**
 * THE LIVE-LOCATION POLICY, held over EVERY route the hub serves — GET and
 * POST, with each route's own variants (test/live-location-routes.ts).
 *
 * Opt-out withholds a developer's LIVE LOCATION from every other viewer on
 * every hub route: current branch, HEAD/base commit, and heartbeat/last-active
 * time. Their work contexts, claims and diagnoses remain shared; that is what
 * the product is for (services/visibility.ts states it).
 *
 * WHAT MAKES IT ABLE TO FAIL, each one a way the previous guard passed while
 * a review found leaks:
 *   - the route list is the APP's, and a route the table does not name fails
 *     the walk — a new GET or POST cannot pass by being unknown
 *   - every route is walked with its OWN variants (the parameters its handler
 *     reads), not one shared query most routes ignore
 *   - the secrets are every spelling of her location: both branches, both
 *     HEADs whole and by every prefix 7–12, and her session start, heartbeat,
 *     stale heartbeat and last update in ISO, ISO-seconds, epoch-ms and
 *     epoch-s form (test/opted-out-world.ts SECRETS)
 *   - the stream is read for its whole window, with an event of hers inside it
 *   - a route promised to show her row must show it (withheld), and a route
 *     that shows none must say why; her OWN view is checked route by route
 */
import { describe, expect, test } from "bun:test";
import { LOCATION_WITHHELD, WITHHELD_TITLE } from "@crosscheck/schema";

import { TEST_ADMIN_TOKEN, jsonRequest } from "./helpers.ts";
import { ROBIN_ID_PARAM, ROUTES } from "./live-location-routes.ts";
import type { RouteSpec, Variant } from "./live-location-routes.ts";
import { secretsIn, seedOptedOutWorld } from "./opted-out-world.ts";
import type { OptedOutWorld, Viewer } from "./opted-out-world.ts";

/** Two of the stream's 1000 ms polls and then some, so a row written inside the window is read. */
const STREAM_WINDOW_MS = 2500;
const STREAM_CHUNK_WAIT_MS = 200;

/** Anything that is Robin's row: her name, address, contexts, claims, question, delivery or sessions. */
const ROBIN_ROW =
  /Robin|robin@example|wc_robin|clm_robin|q_robin|hd_robin|cc_44444444|cc_55555555|cc_66666666|cc_77777777/;

const HTTP_OK_MIN = 200;
const HTTP_OK_MAX = 299;
const HTTP_CLIENT_ERROR_MIN = 400;
const HTTP_CLIENT_ERROR_MAX = 499;

interface Answer {
  readonly key: string;
  readonly variant: Variant;
  readonly status: number;
  readonly body: string;
}

const appRoutes = (world: OptedOutWorld): readonly string[] => [
  ...new Set(
    world.harness.app.routes
      .filter((route) => route.method !== "ALL")
      .map((route) => `${route.method} ${route.path}`),
  ),
];

const methodOf = (key: string): string => key.split(" ")[0] ?? "GET";
const patternOf = (key: string): RegExp =>
  new RegExp(`^${(key.split(" ")[1] ?? "").replace(/:[A-Za-z]+/g, "[^/]+")}$`);

const concretePath = (world: OptedOutWorld, variant: Variant): string =>
  variant.path.replace(ROBIN_ID_PARAM, world.robin.developerId);

const label = (answer: Answer): string =>
  `${answer.key} ${answer.variant.path}${answer.variant.query === undefined ? "" : `?${new URLSearchParams(answer.variant.query).toString()}`}${answer.variant.as === "admin" ? " (admin)" : ""}`;

/** A stream for its WHOLE window — every chunk, not the first. */
const readStream = async (response: Response): Promise<string> => {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return "";
  }
  const decoder = new TextDecoder();
  const until = Date.now() + STREAM_WINDOW_MS;
  let text = "";
  while (Date.now() < until) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<{ readonly done?: boolean; readonly value?: Uint8Array }>((resolve) =>
        setTimeout(() => resolve({}), STREAM_CHUNK_WAIT_MS),
      ),
    ]);
    if (chunk.value !== undefined) {
      text += decoder.decode(chunk.value);
    }
    if (chunk.done === true) {
      break;
    }
  }
  await reader.cancel();
  return text;
};

const requestOf = (world: OptedOutWorld, who: Viewer, key: string, variant: Variant): RequestInit => {
  const developer = who === "nick" ? world.nick : world.robin;
  const cookie = who === "nick" ? world.nickCookie : world.robinCookie;
  const token = variant.as === "admin" ? TEST_ADMIN_TOKEN : developer.apiKey;
  const method = methodOf(key);
  if (method === "GET") {
    return { headers: { Authorization: `Bearer ${token}`, Cookie: cookie } };
  }
  const init = jsonRequest(method, token, variant.body ?? {});
  return { ...init, headers: { ...(init.headers as Record<string, string>), Cookie: cookie } };
};

const call = async (world: OptedOutWorld, who: Viewer, key: string, variant: Variant): Promise<Answer> => {
  const search = variant.query === undefined ? "" : `?${new URLSearchParams(variant.query).toString()}`;
  const response = await world.harness.app.request(
    `${concretePath(world, variant)}${search}`,
    requestOf(world, who, key, variant),
  );
  if (variant.during !== undefined) {
    await variant.during(world);
  }
  const body = key.endsWith("/stream") ? await readStream(response) : await response.text();
  return { key, variant, status: response.status, body };
};

/** Every called route's every variant, in table order: reads first, writes after. */
const walk = async (world: OptedOutWorld, who: Viewer): Promise<readonly Answer[]> => {
  const answers: Answer[] = [];
  for (const [key, spec] of Object.entries(ROUTES)) {
    if (spec.notCalled !== undefined) {
      continue;
    }
    for (const variant of spec.variants) {
      // The admin's view is nobody's self-view.
      if (who === "robin" && variant.as === "admin") {
        continue;
      }
      answers.push(await call(world, who, key, variant));
    }
  }
  return answers;
};

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

    const answers = await walk(world, "nick");

    // Every problem at once, so one run names every route that needs work.
    const problems = [
      ...answers.flatMap((answer) => [
        ...statusProblem(ROUTES[answer.key] as RouteSpec, answer),
        ...secretsIn(answer.body).map((secret) => `${label(answer)}: leaks her ${secret}`),
      ]),
      ...[...byRoute(answers)].flatMap(([key, routeAnswers]) =>
        colleagueProblems(key, ROUTES[key] as RouteSpec, routeAnswers),
      ),
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
