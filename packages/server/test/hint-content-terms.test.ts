/**
 * What the hint pool is ranked and counted on: the prompt's CONTENT terms —
 * never its function words (review 1006b, M8 and L1).
 *
 * The 10-row search pool used to be ranked on the raw tokens, so a German
 * prompt's "das", "ist", "nicht", "die" pulled every German tree that
 * happened to say them into the pool and pushed the one tree the prompt was
 * about out of it, before the per-candidate floor ever ran. And the German
 * stop list was applied to every prompt, so "why does the worker die" lost
 * "die". The stop lists are PostgreSQL's own, mirrored in @crosscheck/schema
 * and pinned here against the database; the German one applies only to a
 * prompt that reads as German.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { ENGLISH_STOP_WORDS, GERMAN_STOP_WORDS } from "@crosscheck/schema";

import {
  addTestDeveloperWithSession,
  createHarnessWithSession,
  createTestHarness,
  jsonRequest,
  postRecords,
  recordEnvelope,
  validClaimBody,
  validWorkContextBody,
  VALID_SESSION_BODY,
} from "./helpers.ts";
import type { TestDeveloper, TestHarness } from "./helpers.ts";

const REPO = VALID_SESSION_BODY.repo;

interface CandidateView {
  readonly workContext: { readonly id: string };
}

const fetchIds = async (
  harness: TestHarness,
  developer: TestDeveloper,
  query: string,
): Promise<readonly string[]> => {
  const search = new URLSearchParams({ repo: REPO, query });
  const response = await harness.app.request(
    `/api/hints/candidates?${search.toString()}`,
    jsonRequest("GET", developer.apiKey),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: { candidates: readonly CandidateView[] } };
  return body.data.candidates.map((candidate) => candidate.workContext.id);
};

describe("the stop lists are the database's own", () => {
  test.each([
    ["english", ENGLISH_STOP_WORDS, 127],
    ["german", GERMAN_STOP_WORDS, 231],
  ] as const)("every word of the %s mirror is a stop word in PostgreSQL, and the list is whole", async (config, words, size) => {
    // Arrange
    const { db } = await createTestHarness();

    // Act — numnode 0 is "the configuration dropped it"
    const result = await db.execute<{ word: string }>(sql`
      SELECT word FROM unnest(ARRAY[${sql.join([...words].map((word) => sql`${word}`), sql`, `)}]::text[]) AS words(word)
      WHERE numnode(plainto_tsquery(${config}::regconfig, word)) > 0`);

    // Assert
    expect(result.rows.map((row) => row.word)).toEqual([]);
    expect(words.size).toBe(size);
  });

  test("task words are not on either list", async () => {
    // Arrange
    const { db } = await createTestHarness();
    const taskWords = ["upload", "limit", "worker", "refresh", "zurückgesetzt", "abbruch"];

    // Act
    const result = await db.execute<{ word: string }>(sql`
      SELECT word FROM unnest(ARRAY[${sql.join(taskWords.map((word) => sql`${word}`), sql`, `)}]::text[]) AS words(word)
      WHERE numnode(plainto_tsquery('english', word)) = 0 OR numnode(plainto_tsquery('german', word)) = 0`);

    // Assert
    expect(result.rows).toEqual([]);
    expect(taskWords.some((word) => ENGLISH_STOP_WORDS.has(word) || GERMAN_STOP_WORDS.has(word))).toBe(false);
  });
});

describe("German function words never rank the pool (M8)", () => {
  /** Twelve German trees full of das/ist/nicht/die, and the one about the upload limit. */
  const NOISE = [
    "Das ist nicht die Ursache und das ist auch nicht die Lösung, die wir wollen",
    "Die Tabelle ist nicht sortiert und die Spalten sind nicht die richtigen",
    "Das Spieler-Profil ist nicht vollständig und die Fotos sind nicht da",
    "Die Liga-Auswahl ist nicht stabil und das Menü ist nicht die neue Version",
    "Das Training ist nicht geplant und die Einheiten sind nicht die aktuellen",
    "Die Heatmap ist nicht korrekt und das Raster ist nicht die echte Feldgröße",
    "Das Video ist nicht synchron und die Uhr ist nicht die vom Feed",
    "Die Statistik ist nicht aktuell und das Datum ist nicht die neue Saison",
    "Das Login ist nicht sicher und die Sitzung ist nicht die richtige",
    "Die Exporte sind nicht vollständig und das PDF ist nicht die neue Vorlage",
    "Das Dashboard ist nicht schnell und die Kacheln sind nicht die gecachten",
    "Die Benachrichtigung ist nicht zugestellt und das Token ist nicht die neue",
  ];

  /** Three copies of each noise sentence: more than the 10-row pool, as a busy German repo has. */
  const NOISE_TREES = [1, 2, 3].flatMap((copy) => NOISE.map((text) => `${text} (${String(copy)})`));

  const crowdedHub = async (): Promise<{ harness: TestHarness; robin: TestDeveloper }> => {
    const { harness, developer: nick } = await createHarnessWithSession();
    const records = [
      recordEnvelope("work_context", validWorkContextBody({ id: "wc_target", title: "Upload-Limit der Trainingsvideos", description: "Chunked Upload" })),
      recordEnvelope("claim", validClaimBody({ id: "c_target", workContextId: "wc_target", body: "Das Upload-Limit wird am Gateway nicht erhöht, deshalb brechen große Uploads ab." })),
      ...NOISE_TREES.flatMap((text, index) => [
        recordEnvelope("work_context", validWorkContextBody({ id: `wc_n${String(index)}`, title: text.slice(0, 60), description: text })),
        recordEnvelope("claim", validClaimBody({ id: `c_n${String(index)}`, workContextId: `wc_n${String(index)}`, body: text })),
      ]),
    ];
    const seeded = await postRecords(harness, nick, { records });
    expect(seeded.data?.accepted).toBe(records.length);
    const robin = await addTestDeveloperWithSession(harness, "Robin", "robin@example.com", { id: "ses_02" });
    return { harness, robin };
  };

  test.each([
    ["warum wird das Upload-Limit nicht erhöht, die Uploads brechen ab"],
    ["das ist nicht die Lösung und die ist nicht gut, das Upload-Limit ist das Problem"],
  ])("%p reaches the upload tree through a pool of German noise", async (query) => {
    // Arrange
    const { harness, robin } = await crowdedHub();

    // Act
    const ids = await fetchIds(harness, robin, query);

    // Assert
    expect(ids).toContain("wc_target");
  });
});

describe("the German stop list applies only to a German prompt (L1)", () => {
  const workerTree = async (): Promise<{ harness: TestHarness; robin: TestDeveloper }> => {
    const { harness, developer: nick } = await createHarnessWithSession();
    const seeded = await postRecords(harness, nick, {
      records: [
        recordEnvelope("work_context", validWorkContextBody({ title: "Worker dies on deploy", description: "Queue worker" })),
        recordEnvelope("claim", validClaimBody({ id: "c_worker", body: "The worker dies when SIGTERM arrives mid-batch." })),
      ],
    });
    expect(seeded.data?.accepted).toBe(2);
    const robin = await addTestDeveloperWithSession(harness, "Robin", "robin@example.com", { id: "ses_02" });
    return { harness, robin };
  };

  test("\"why does the worker die\" keeps \"die\", and the tree it shares two words with is found", async () => {
    // Arrange
    const { harness, robin } = await workerTree();

    // Act
    const ids = await fetchIds(harness, robin, "why does the worker die");

    // Assert
    expect(ids.length).toBe(1);
  });
});

describe("German function words german.stop lacks never count on the hub (hold-out review, M4)", () => {
  test.each([["ok, ich glaube dass es passt, weiter"], ["ja, das wurde so gemacht, passt"], ["hast du das gesehen?"]])(
    "%p matches no German tree that says those words",
    async (prompt) => {
      // Arrange — both claims say glaube, dass, wurde, gemacht, hast, gesehen
      const { harness, developer: nick } = await createHarnessWithSession();
      const seeded = await postRecords(harness, nick, {
        records: [
          recordEnvelope("work_context", validWorkContextBody({ title: "Video-Upload bricht ab", description: "Gateway" })),
          recordEnvelope("claim", validClaimBody({ id: "c_de1", body: "Ich glaube, dass der Upload-Worker wartet, weil das Limit nicht zurückgesetzt wurde." })),
          recordEnvelope("claim", validClaimBody({ id: "c_de2", body: "Der Fix wurde gestern gemacht, hast du den Gateway-Test gesehen?" })),
        ],
      });
      expect(seeded.data?.accepted).toBe(3);
      const robin = await addTestDeveloperWithSession(harness, "Robin", "robin@example.com", { id: "ses_02" });

      // Act
      const ids = await fetchIds(harness, robin, prompt);

      // Assert
      expect(ids).toEqual([]);
    },
  );
});

describe("two capitals are a shared word on the hub too (M6)", () => {
  test("\"CI rot auf main\" finds the tree about CI on main", async () => {
    // Arrange — "CI" and "main" are the two words it shares; "rot" is German for red
    const { harness, developer: nick } = await createHarnessWithSession();
    const seeded = await postRecords(harness, nick, {
      records: [
        recordEnvelope("work_context", validWorkContextBody({ title: "CI pipeline red on main", description: "Lint before build" })),
        recordEnvelope("claim", validClaimBody({ id: "c_ci", body: "CI is red on main because the lint step runs before the build." })),
      ],
    });
    expect(seeded.data?.accepted).toBe(2);
    const robin = await addTestDeveloperWithSession(harness, "Robin", "robin@example.com", { id: "ses_02" });

    // Act
    const ids = await fetchIds(harness, robin, "CI rot auf main");

    // Assert
    expect(ids.length).toBe(1);
  });
});
