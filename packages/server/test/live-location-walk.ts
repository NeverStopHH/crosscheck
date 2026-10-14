/**
 * THE WALK: every route of the table (test/live-location-routes.ts), every
 * variant, as one developer of the opted-out world — shared by the guard
 * (live-location-privacy.test.ts), which scans each answer for her
 * location, and by the differential (live-location-differential.test.ts),
 * which compares the answers of two worlds that differ by one action of hers.
 * One walk, so the two can never be walking different routes.
 */
import { TEST_ADMIN_TOKEN, jsonRequest } from "./helpers.ts";
import { ROBIN_ID_PARAM, ROUTES } from "./live-location-routes.ts";
import type { Variant } from "./live-location-routes.ts";
import type { OptedOutWorld } from "./opted-out-world.ts";

/** Who walks: the world's three developers. */
export type Walker = "nick" | "ken" | "robin";

/** Two of the stream's 1000 ms polls and then some, so a row written inside the window is read. */
const STREAM_WINDOW_MS = 2500;
const STREAM_CHUNK_WAIT_MS = 200;

/**
 * Headers that are the transport's, not the hub's answer: the wall-clock
 * date and the session cookie a login sets. Every other header is scanned
 * and compared like the body (review round 4, H5: the guard read no header).
 */
const TRANSPORT_HEADERS: ReadonlySet<string> = new Set(["date", "set-cookie"]);

export interface Answer {
  readonly key: string;
  readonly variant: Variant;
  readonly status: number;
  /** `name: value` per header, sorted, transport headers left out. */
  readonly headers: string;
  readonly body: string;
}

export const appRoutes = (world: OptedOutWorld): readonly string[] => [
  ...new Set(
    world.harness.app.routes
      .filter((route) => route.method !== "ALL")
      .map((route) => `${route.method} ${route.path}`),
  ),
];

export const methodOf = (key: string): string => key.split(" ")[0] ?? "GET";

export const patternOf = (key: string): RegExp =>
  new RegExp(`^${(key.split(" ")[1] ?? "").replace(/:[A-Za-z]+/g, "[^/]+")}$`);

export const concretePath = (world: OptedOutWorld, variant: Variant): string =>
  variant.path.replace(ROBIN_ID_PARAM, world.robin.developerId);

export const label = (answer: Pick<Answer, "key" | "variant">): string =>
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

const credentialsOf = (world: OptedOutWorld, who: Walker): { readonly apiKey: string; readonly cookie: string } => {
  switch (who) {
    case "nick":
      return { apiKey: world.nick.apiKey, cookie: world.nickCookie };
    case "ken":
      return { apiKey: world.ken.apiKey, cookie: world.kenCookie };
    case "robin":
      return { apiKey: world.robin.apiKey, cookie: world.robinCookie };
  }
};

const requestOf = (world: OptedOutWorld, who: Walker, key: string, variant: Variant): RequestInit => {
  const { apiKey, cookie } = credentialsOf(world, who);
  const token = variant.as === "admin" ? TEST_ADMIN_TOKEN : apiKey;
  const method = methodOf(key);
  if (method === "GET") {
    return { headers: { Authorization: `Bearer ${token}`, Cookie: cookie } };
  }
  const init = jsonRequest(method, token, variant.body ?? {});
  return { ...init, headers: { ...(init.headers as Record<string, string>), Cookie: cookie } };
};

const headersOf = (response: Response): string =>
  [...response.headers.entries()]
    .filter(([name]) => !TRANSPORT_HEADERS.has(name.toLowerCase()))
    .map(([name, value]) => `${name.toLowerCase()}: ${value}`)
    .sort()
    .join("\n");

export const call = async (world: OptedOutWorld, who: Walker, key: string, variant: Variant): Promise<Answer> => {
  const search = variant.query === undefined ? "" : `?${new URLSearchParams(variant.query).toString()}`;
  const response = await world.harness.app.request(
    `${concretePath(world, variant)}${search}`,
    requestOf(world, who, key, variant),
  );
  if (variant.during !== undefined) {
    await variant.during(world);
  }
  const body = key.endsWith("/stream") ? await readStream(response) : await response.text();
  return { key, variant, status: response.status, headers: headersOf(response), body };
};

/**
 * Every called route's every variant, in table order: reads first, writes
 * after. `before` hears each route's key as its variants are called — the
 * guard's parameter recorder attributes what a handler reads by it.
 */
export const walk = async (
  world: OptedOutWorld,
  who: Walker,
  before: (key: string) => void = () => undefined,
): Promise<readonly Answer[]> => {
  const answers: Answer[] = [];
  for (const [key, spec] of Object.entries(ROUTES)) {
    if (spec.notCalled !== undefined) {
      continue;
    }
    before(key);
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

/** Anything that is Robin's row: her name, address, contexts, claims, question, delivery, pin or sessions. */
export const ROBIN_ROW =
  /Robin|robin@example|wc_robin|clm_robin|q_robin|hd_robin|pin_robin|cc_44444444|cc_55555555|cc_66666666|cc_77777777|cc_aaaaaaaa/;
