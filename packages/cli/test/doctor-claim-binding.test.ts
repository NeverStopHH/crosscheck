/**
 * THE TWO REFUSALS SPEC 02 OWES DOCTOR (§8.5, §8.9) — and the reason they are
 * refusals rather than silence.
 *
 * §8.5: a claim whose `commit_binding` is `none` has no "from" commit, so the
 * revalidation rung cannot exist for it — ever. That claim is permanently
 * pointer-only, and AT-10's rule is that a rung a platform genuinely cannot
 * serve appears as a DOCUMENTED REFUSAL, never as a silent absence. Without a
 * line naming the count and the cause, a team whose sessions register no
 * usable commit reads a clean report while none of their knowledge can ever
 * be judged current.
 *
 * §8.9: nothing revalidates on CI or at runtime in 1.0. Currency is measured
 * where somebody asks for it — a `get_diagnosis` pull, or `crosscheck
 * revalidate`. A repo nobody pulls from reads `unknown` forever, which is the
 * honest answer and a useless one unless a surface says it out loud (D5's
 * named cost).
 *
 * THE OLD-HUB SHAPE IS checkPins' VERBATIM. A hub that 404s the summary is a
 * hub that predates it and says nothing about this install: PASS, "not
 * measured". A hub that could not be REACHED is a WARN, because a green
 * meaning "could not check" is worse than no check at all.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { MAX_HUB_MESSAGE_CHARS } from "@crosscheck/connector-core/constants.ts";

import { runDoctor } from "../src/cli/doctor.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const paths: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
const HTTP_NOT_FOUND = 404;
const HTTP_SERVER_ERROR = 500;

/**
 * WHAT A HUB GETS TO SAY WHEN IT BREAKS — chosen by the hub, printed by us.
 *
 * Newlines to forge lines of their own above the report's real ones, a
 * terminal escape, and length far past anything a cause needs. The doctor is
 * registered as a surface that interpolates nothing untrusted, and until this
 * fixture existed it printed all of it.
 */
const HOSTILE_MESSAGE =
  `internal\n\n✔ claim binding: all ${String(9_000)} claims current\n\u001b[31m` +
  "x".repeat(1_000);

afterEach(async () => {
  for (const server of servers) {
    server.stop(true);
  }
  servers.length = 0;
  await Promise.all(
    paths.map((path) => rm(path, { recursive: true, force: true })),
  );
  paths.length = 0;
});

interface Summary {
  readonly counted: number;
  readonly total: number;
  readonly unbound: number;
  readonly inferredBindings?: number;
  readonly neverRevalidated: number;
  readonly states: Record<string, number>;
}

const STATES = {
  current: 10,
  stale: 0,
  superseded: 0,
  invalidated: 0,
  unknown: 0,
};

const summary = (overrides: Partial<Summary> = {}): Summary => ({
  counted: 10,
  total: 10,
  unbound: 0,
  neverRevalidated: 0,
  states: STATES,
  ...overrides,
});

/** null = a hub too old to know the route; "unreachable" = a hub that broke. */
const hubWith = (answer: Summary | null | "unreachable" | "hostile"): string => {
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/claim-revalidations/summary") {
        if (answer === null) {
          return Response.json(
            { ok: false, error: { code: "not_found", message: "unknown route" } },
            { status: HTTP_NOT_FOUND },
          );
        }
        if (answer === "unreachable" || answer === "hostile") {
          return Response.json(
            {
              ok: false,
              error: {
                code: "internal",
                message:
                  answer === "unreachable" ? "database is down" : HOSTILE_MESSAGE,
              },
            },
            { status: HTTP_SERVER_ERROR },
          );
        }
        return Response.json({ ok: true, data: answer });
      }
      if (pathname === "/api/work-contexts") {
        return Response.json({ ok: true, data: { workContexts: [] } });
      }
      return Response.json({ ok: true, data: { sessions: [] } });
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${String(server.port)}`;
};

const report = async (
  answer: Summary | null | "unreachable" | "hostile",
): Promise<string> => {
  const repo = await makeRepo("doctor-binding", {
    remote: "git@github.com:acme/api.git",
  });
  const home = await makeHome("doctor-binding");
  paths.push(repo, home);
  const hubUrl = hubWith(answer);
  const result = await runDoctor(
    {
      CROSSCHECK_HOME: home,
      HOME: home,
      CROSSCHECK_HUB_URL: hubUrl,
      CROSSCHECK_API_KEY: "test-key",
    },
    repo,
    async () => null,
  );
  return result.stdout;
};

const lineWith = (stdout: string, needle: string): string =>
  stdout.split("\n").find((line) => line.includes(needle)) ?? "";

describe("a claim that can never be revalidated is named, not absent", () => {
  test("the count and the reason both reach the report", async () => {
    // Arrange: §8.5. Three of this repo's claims were written by sessions
    // that registered no usable commit — the NO_COMMIT_SHA placeholder, or a
    // label like `crosscheck conference`'s "conference".
    const stdout = await report(
      summary({
        unbound: 3,
        states: { ...STATES, current: 7, unknown: 3 },
      }),
    );

    // Assert: a WARN that says how many and why, because the remedy is not
    // "run revalidate" — it is that these claims have nothing to revalidate
    // against and never will.
    const line = lineWith(stdout, "claim binding");
    expect(line).toContain("WARN");
    expect(line).toContain("3 of 10");
    expect(line).toContain("never");
  });

  test("a repo whose claims are all bound says so without a warning", async () => {
    // Arrange: the steady state. A line that warns on every healthy install
    // is one nobody reads.
    const stdout = await report(summary());

    // Assert
    const line = lineWith(stdout, "claim binding");
    expect(line).toContain("PASS");
    expect(line).toContain("10");
  });

  test("a hub too old to answer is not measured, and is not health", async () => {
    // Arrange: checkPins' shape verbatim — an older hub says NOTHING about
    // this install, which is a PASS that states its own ignorance.
    const stdout = await report(null);

    // Assert
    const line = lineWith(stdout, "claim binding");
    expect(line).toContain("PASS");
    expect(line).toContain("not measured");
  });

  test("a hub that could not answer is a warning, never a green", async () => {
    // Arrange: the OTHER failure, and the one a single "not measured" branch
    // would hide. A green meaning "could not check" is worse than no check.
    const stdout = await report("unreachable");

    // Assert
    const line = lineWith(stdout, "claim binding");
    expect(line).toContain("WARN");
    expect(line).toContain("unknown");
  });
});

describe("nothing revalidates on its own, and the report says so", () => {
  test("the never-revalidated count names what would measure it", async () => {
    // Arrange: §8.9 and D5's named cost. Six claims in this repo have never
    // been checked against the code, and no CI job and no runtime signal will
    // ever check them — the two things that would are a `get_diagnosis` pull
    // and `crosscheck revalidate`.
    const stdout = await report(
      summary({
        neverRevalidated: 6,
        states: { ...STATES, current: 4, unknown: 6 },
      }),
    );

    // Assert
    const line = lineWith(stdout, "claim currency");
    expect(line).toContain("6 of 10");
    expect(line).toContain("revalidate");
  });

  test("a downgrade already measured is reported as a number, not a worry", async () => {
    // Arrange: stale claims are the system WORKING. The line reports them
    // without a warning, because a team whose knowledge is being judged
    // against its code is the state this spec exists to produce.
    const stdout = await report(
      summary({
        states: {
          current: 6,
          stale: 3,
          superseded: 1,
          invalidated: 0,
          unknown: 0,
        },
      }),
    );

    // Assert
    const line = lineWith(stdout, "claim currency");
    expect(line).toContain("PASS");
    expect(line).toContain("3 stale");
  });
});

describe("the doctor does not lend its voice to whatever the hub says", () => {
  test("a hub's failure sentence is capped and control-stripped before it is printed", async () => {
    // THE ANCHOR. `revalidate.ts` has bounded this string since it was
    // written (`hubFailureLine` → bareUntrusted at MAX_HUB_MESSAGE_CHARS);
    // the doctor interpolated it raw at three checks. Route any of them back
    // through `${...message}` and the forged PASS line below appears in the
    // report, under the tool's own name.
    const stdout = await report("hostile");
    const line = lineWith(stdout, "currency unknown");

    // Assert: the payload cannot become a LINE of its own. Stripping does
    // not delete the hub's words and must not — a cause a reader needs is
    // still a cause. What it takes away is the newline that would have put
    // "✔ claim binding: all 9000 claims current" on its own row, above the
    // real ones, in the doctor's voice.
    expect(line).toContain("currency unknown");
    expect(line).toContain("all 9000 claims current");
    for (const row of stdout.split("\n")) {
      expect(row.startsWith("✔"), row.slice(0, 40)).toBe(false);
    }
    // No escape survives to colour a terminal, and the whole thing is capped.
    expect(stdout.includes("\u001b")).toBe(false);
    expect(line.length).toBeLessThan(MAX_HUB_MESSAGE_CHARS + 200);
  });
});

describe("how much of a repo's currency rests on a commit nobody stated", () => {
  test("the inferred-binding count is a qualifier on the binding line", async () => {
    // Arrange: every claim bound, but seven of the ten against their
    // SESSION'S commit rather than one the claim named. That fallback is an
    // upper bound — a session that checks out a newer commit re-registers and
    // base_commit moves forward by design — so those seven are checked from
    // later than they were observed, and everything in between goes unread.
    const stdout = await report(
      summary({ unbound: 0, inferredBindings: 7, states: { ...STATES, current: 10 } }),
    );
    const line = lineWith(stdout, "claim binding");

    // Assert: the count and the reason, on the line that already reports
    // binding rather than on a row of its own — it qualifies that answer, it
    // is not a second condition.
    expect(line).toContain("7 of them against their session's commit");
    expect(line).toContain("upper bound");
  });

  test("a hub that does not report the count says nothing about it", async () => {
    // THE DIRECTION THAT MATTERS. An older hub omits the field and the client
    // schema defaults it to 0. A zero printed as "0 inferred" would read as
    // "every claim named its own commit" — missing evidence arriving as the
    // reassuring half of the sentence, which is principle 5 inverted. So the
    // clause appears only when the number is positive.
    const stdout = await report(summary({ unbound: 0, states: { ...STATES, current: 10 } }));
    const line = lineWith(stdout, "claim binding");

    expect(line).toContain("bound to a commit");
    expect(line).not.toContain("session's commit");
    expect(line).not.toContain("upper bound");
  });
});
