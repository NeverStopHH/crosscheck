/**
 * THE OTHER HALF OF THE BOUNDARY (review round 4, the unfinished probe): a
 * developer who did NOT opt out is never shown in withheld form, on any of
 * the table's routes. The guard (live-location-privacy.test.ts) proves her
 * location is withheld; this proves nothing else is — a projection that
 * withheld by default could otherwise withhold the wrong owner's row and
 * still pass every privacy test.
 *
 * Two readings of "nobody else":
 *   - with every developer told (Robin opted back in), no answer anywhere
 *     carries a withheld form, for any walker;
 *   - with Robin opted out, every withheld form Ken or Nick reads sits in a
 *     row of HERS: the JSON object holding it, or one it is nested in, is
 *     hers by her id, her name or one of her row ids.
 */
import { describe, expect, test } from "bun:test";
import { LOCATION_WITHHELD, WITHHELD_TITLE } from "@crosscheck/schema";

import { jsonRequest } from "./helpers.ts";
import { ROBIN_ROW, label, walk } from "./live-location-walk.ts";
import type { Answer, Walker } from "./live-location-walk.ts";
import { seedOptedOutWorld } from "./opted-out-world.ts";
import type { OptedOutWorld } from "./opted-out-world.ts";

const WITHHELD_FORMS: readonly string[] = [LOCATION_WITHHELD, WITHHELD_TITLE];

const carriesWithheldForm = (text: string): boolean => WITHHELD_FORMS.some((form) => text.includes(form));

const parsedJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

/**
 * HER ACTS INSIDE A TEAMMATE'S ROW, whose instant is hers to withhold:
 *   - a revalidation reading she took of a teammate's claim (the seed's
 *     re-check of clm_nick): a reading is its reporter's
 *     (services/claim-validity.ts)
 *   - commit evidence her SessionStart collected about a teammate or an
 *     outside committer (the seed's report naming Ken and Sam): the row
 *     counts for everyone, and when she collected it is hers
 *     (services/absences.ts, review round 5, C1)
 */
const CLAIMS_SHE_REVALIDATED: ReadonlySet<string> = new Set(["clm_nick"]);
const AUTHORS_SHE_REPORTED: ReadonlySet<string> = new Set(["Ken", "Sam"]);

/** Does this value name her: her id, her name or a row id of hers? */
const namesHer = (world: OptedOutWorld, value: unknown): boolean =>
  typeof value === "string" && (ROBIN_ROW.test(value) || value === world.robin.developerId);

type Row = Readonly<Record<string, unknown>>;

const isRow = (value: unknown): value is Row => value !== null && typeof value === "object" && !Array.isArray(value);

/** A row is hers when one of its own fields names her, or one of the rows it holds as a field does. */
const isHerRow = (world: OptedOutWorld, row: Row): boolean =>
  Object.values(row).some(
    (item) => namesHer(world, item) || (isRow(item) && Object.values(item).some((inner) => namesHer(world, inner))),
  );

/** The field of this row that carries an act of hers, if it is such a row. */
const herActField = (row: Row): string | null => {
  const claim = isRow(row["claim"]) ? row["claim"] : row;
  if (typeof claim["id"] === "string" && CLAIMS_SHE_REVALIDATED.has(claim["id"])) {
    return "validity.lastRevalidatedAt";
  }
  return typeof row["evidenceCollectedAt"] === "string" && typeof row["name"] === "string" && AUTHORS_SHE_REPORTED.has(row["name"])
    ? "evidenceCollectedAt"
    : null;
};

/**
 * Every path holding a withheld form that is NOT inside a row of hers. Each
 * row of a LIST is judged on its own — a list holds rows of many owners —
 * and a row's own fields inherit its owner.
 */
const strayForms = (
  world: OptedOutWorld,
  value: unknown,
  path: string,
  insideHers: boolean,
  actField: string | null,
): readonly string[] => {
  if (typeof value === "string") {
    const isHerActTime = actField !== null && path.endsWith(actField);
    return carriesWithheldForm(value) && !insideHers && !isHerActTime ? [path] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => strayForms(world, item, `${path}[${String(index)}]`, false, null));
  }
  if (isRow(value)) {
    const hers = insideHers || isHerRow(world, value);
    const field = actField ?? herActField(value);
    return Object.entries(value).flatMap(([key, item]) =>
      strayForms(world, item, path === "" ? key : `${path}.${key}`, hers, field),
    );
  }
  return [];
};

/** A withheld form outside her rows: by JSON path, or — for a page — anywhere on a page that names her nowhere. */
const strayFormsIn = (world: OptedOutWorld, answer: Answer): readonly string[] => {
  const json = parsedJson(answer.body);
  if (json !== undefined) {
    return strayForms(world, json, "", false, null).map((path) => `${label(answer)}: ${path}`);
  }
  return carriesWithheldForm(answer.body) && !ROBIN_ROW.test(answer.body)
    ? [`${label(answer)}: a withheld form on a page that names none of her work`]
    : [];
};

const WALKERS: readonly Walker[] = ["nick", "ken"];

describe("a developer who did not opt out is never shown withheld", () => {
  test("with Robin opted back in, no walker reads a withheld form on any route", async () => {
    const world = await seedOptedOutWorld();
    const back = await world.harness.app.request("/api/settings/presence", jsonRequest("PUT", world.robin.apiKey, { optOut: false }));
    expect(back.status).toBe(200);

    const forms: string[] = [];
    for (const who of [...WALKERS, "robin"] as const) {
      const answers = await walk(world, who);
      forms.push(
        ...answers
          .filter((answer) => carriesWithheldForm(answer.body) || carriesWithheldForm(answer.headers))
          .map((answer) => `${who} · ${label(answer)}`),
      );
    }

    expect(forms).toEqual([]);
  }, 300_000);

  test.each(WALKERS.map((who) => [who] as const))(
    "with Robin opted out, every withheld form %s reads sits in a row of hers",
    async (who) => {
      const world = await seedOptedOutWorld();

      const answers = await walk(world, who);

      expect(answers.flatMap((answer) => [
        ...strayFormsIn(world, answer),
        ...(carriesWithheldForm(answer.headers) ? [`${label(answer)}: a withheld form in a header`] : []),
      ])).toEqual([]);
    },
    300_000,
  );
});
