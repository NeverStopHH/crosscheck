/**
 * The conclusion-capture corpus harness (trial finding #12): every fixture in
 * test/fixtures/conclusion-corpus/format.ts through the REAL gate — the real
 * transcript tail read, the real slice rendering, the real fire predicate —
 * and, for positives, through the REAL worker/spool path with a fake
 * summarizer emitting the fixture's distillation. No LLM anywhere; the
 * corpus IS the spec the gate and prompt are held to.
 *
 * THE FLOORS ENCODE TODAY'S INTENT, NOT MEASURED TRUTH — the precision
 * corpus's rule, restated for capture: every fixture is hand-labeled to
 * defensible behavior, so a metric below its floor is a REGRESSION against
 * declared intent. Relabel a fixture (with rationale in format.ts) when
 * intent legitimately changes; never tune a floor down to make one pass.
 *
 * Corpus size, derived from the data so this header cannot rot:
 *
 * VERIFY: bun -e 'const {loadConclusionCorpus}=await import("./packages/connector-claude/test/fixtures/conclusion-corpus/format.ts");const c=loadConclusionCorpus();console.log(c.length,c.filter(f=>f.expect==="draft").length,c.filter(f=>f.expect==="none").length)'
 * PRINTS: 20 7 13
 *
 * THE HARNESS CAN FAIL — proven continuously: scripts/mutation-check.ts
 * deletes each of the six conclusion predicates from the gate in turn
 * (verdict, rejection, review-finding signal, review-finding anchor,
 * suite-flip signal, commit boundary), and this file must go red on exactly
 * the fixture whose `loadBearing` names the deleted predicate.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DERIVED_CONFIDENCE_CAP, MAX_CLAIM_BODY_LENGTH } from "@crosscheck/schema";

import { readSpoolLines, repoKey } from "../src/index.ts";
import {
  hasCommitBoundary,
  hasRejectionLanguage,
  hasReviewFindingShape,
  hasReviewFindingSignal,
  hasSuiteFlip,
  hasVerdictLanguage,
  isCaptureMoment,
  isConclusionMoment,
  isDiagnosisMoment,
} from "../src/summarizer/gate.ts";
import { parseSummarizerOutput } from "../src/summarizer/parse.ts";
import { SUMMARIZER_PROMPT } from "../src/summarizer/runner.ts";
import { extractSliceText, readTurnSlice } from "../src/summarizer/transcript.ts";
import { runSummarizeWorker } from "../src/summarizer/worker.ts";
import { writeSessionState } from "@crosscheck/connector-core/state/session-state.ts";
import { makeHome } from "../../connector-core/test/helpers.ts";
import { loadConclusionCorpus } from "./fixtures/conclusion-corpus/format.ts";
import type {
  ConclusionFixture,
  Distillation,
} from "./fixtures/conclusion-corpus/format.ts";

/**
 * Minimum acceptable metrics — named floors the CI gauntlet enforces, the
 * precision corpus's arrangement applied to capture. Lower one only with a
 * written rationale here; relabel a fixture (with rationale in format.ts)
 * when intent legitimately changes.
 *
 * VERIFY: grep -c 'FLOOR_CONCLUSION_[A-Z_]* = 1;' packages/connector-claude/test/conclusion-corpus.test.ts
 * PRINTS: 3
 */
export const FLOOR_CONCLUSION_GATE_RECALL = 1;
export const FLOOR_CONCLUSION_GATE_SILENCE = 1;
export const FLOOR_CONCLUSION_DRAFT_YIELD = 1;

const corpus = loadConclusionCorpus();
const positives = corpus.filter((fixture) => fixture.expect === "draft");
const negatives = corpus.filter((fixture) => fixture.expect === "none");

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(
    paths.map((path) => rm(path, { recursive: true, force: true })),
  );
  paths.length = 0;
});

const tempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "cx-conclusion-"));
  paths.push(dir);
  return dir;
};

/** The REAL gate path: bounded tail read, slice render, fire predicate. */
const gateDecision = async (fixture: ConclusionFixture): Promise<boolean> => {
  const dir = await tempDir();
  const transcript = join(dir, "transcript.jsonl");
  await writeFile(transcript, fixture.transcript, "utf8");
  const slice = await readTurnSlice(transcript);
  expect(slice).not.toBeNull();
  const text = extractSliceText(slice?.raw ?? "");
  expect(text.length).toBeGreaterThan(0);
  return isCaptureMoment(text);
};

/** A fake summarizer binary that answers `output` — the injectable runner. */
const makeFakeSummarizer = async (output: string): Promise<string> => {
  const dir = await tempDir();
  const script = join(dir, "fake.ts");
  await writeFile(
    script,
    `await Bun.stdin.text();\nprocess.stdout.write(${JSON.stringify(output)});\n`,
    "utf8",
  );
  const wrapper = join(dir, "fake.sh");
  await writeFile(
    wrapper,
    `#!/bin/sh\nexec "${process.execPath}" "${script}"\n`,
    "utf8",
  );
  await chmod(wrapper, 0o755);
  return wrapper;
};

const REPO_ID = "github.com/acme/api";
const HUB_URL = "http://127.0.0.1:1";

interface SpooledClaim {
  readonly kind: string;
  readonly body: {
    readonly kind: string;
    readonly body: string;
    readonly status: string;
    readonly confidence: number;
    readonly captureMode: string;
    readonly provenance: string;
  };
}

/**
 * The REAL worker/spool path: the fixture's transcript on disk, a session
 * state to attribute to, the fake summarizer answering `output`, and the
 * in-process worker entry the detached process runs.
 */
const runWorkerOn = async (
  fixture: ConclusionFixture,
  output: string,
): Promise<readonly SpooledClaim[]> => {
  const home = await makeHome(`conclusion-${fixture.name}`);
  paths.push(home);
  const dir = await tempDir();
  const transcript = join(dir, "transcript.jsonl");
  await writeFile(transcript, fixture.transcript, "utf8");
  const sessionId = `corpus-${fixture.name}`;
  await writeSessionState(home, {
    hostSessionKey: sessionId,
    crosscheckSessionId: `cc_${sessionId}`,
    workContextId: `wc_cc_${sessionId}`,
    repoId: REPO_ID,
    repoRoot: dir,
    hubUrl: HUB_URL,
    developerId: "dev_self",
    startedAt: new Date().toISOString(),
  });
  const fake = await makeFakeSummarizer(output);
  const exitCode = await runSummarizeWorker(
    [
      "--transcript",
      transcript,
      "--session",
      sessionId,
      "--slice-start",
      "0",
      "--slice-end",
      String(Buffer.byteLength(fixture.transcript)),
    ],
    { CROSSCHECK_HOME: home, CROSSCHECK_SUMMARIZER_CMD: fake },
  );
  expect(exitCode).toBe(0);
  return (await readSpoolLines(home, repoKey(HUB_URL, REPO_ID)))
    .map((spoolLine) => JSON.parse(spoolLine) as SpooledClaim)
    .filter((record) => record.kind === "claim");
};

const distillationJson = (distillation: Distillation): string =>
  JSON.stringify(distillation);

describe("conclusion corpus: the gate", () => {
  for (const fixture of positives) {
    test(`fires on ${fixture.name} (${fixture.loadBearing ?? "?"})`, async () => {
      expect(await gateDecision(fixture)).toBe(true);
    });
  }

  for (const fixture of negatives) {
    test(`stays silent on ${fixture.name}`, async () => {
      expect(await gateDecision(fixture)).toBe(false);
    });
  }

  test("gate recall holds the floor — every positive fires", async () => {
    const decisions = await Promise.all(positives.map(gateDecision));
    const recall = decisions.filter(Boolean).length / positives.length;
    expect(recall).toBeGreaterThanOrEqual(FLOOR_CONCLUSION_GATE_RECALL);
  });

  test("gate silence holds the floor — no negative fires", async () => {
    const decisions = await Promise.all(negatives.map(gateDecision));
    const silence = decisions.filter((fired) => !fired).length / negatives.length;
    expect(silence).toBeGreaterThanOrEqual(FLOOR_CONCLUSION_GATE_SILENCE);
  });

  test("each positive names the one predicate it holds in place", () => {
    // A fixture whose firing is over-determined pins nothing — the mutation
    // catalogue's five gate entries rely on these labels being real.
    const labels = positives.map((fixture) => fixture.loadBearing);
    expect(labels).toContain("hasVerdictLanguage");
    expect(labels).toContain("hasRejectionLanguage");
    expect(labels).toContain("hasReviewFindingShape");
    expect(labels).toContain("hasReviewFindingSignal");
    expect(labels).toContain("hasSuiteFlip");
    expect(labels).toContain("hasCommitBoundary");
    expect(labels).toContain("isDiagnosisMoment");
  });

  test("the conclusion wing never cannibalizes the debugging wing", async () => {
    // The livelock fixture must fire through isDiagnosisMoment ALONE — a
    // widening that only works because the conclusion wing happens to match
    // would let the original heuristics rot underneath it.
    const livelock = positives.find(
      (fixture) => fixture.loadBearing === "isDiagnosisMoment",
    );
    expect(livelock).toBeDefined();
    const dir = await tempDir();
    const transcript = join(dir, "livelock.jsonl");
    await writeFile(transcript, livelock?.transcript ?? "", "utf8");
    const slice = await readTurnSlice(transcript);
    const text = extractSliceText(slice?.raw ?? "");
    expect(isDiagnosisMoment(text)).toBe(true);
  });
});

describe("conclusion corpus: the worker/spool path", () => {
  for (const fixture of positives) {
    test(`${fixture.name} yields one ${fixture.distillation?.kind ?? "?"} draft`, async () => {
      // Arrange: the fixture's distillation must be parseable AT ALL — a
      // corpus output the tolerant parse discards would test nothing.
      const distillation = fixture.distillation;
      expect(distillation).toBeDefined();
      if (distillation === undefined) {
        return;
      }
      const parsed = parseSummarizerOutput(distillationJson(distillation));
      expect(parsed?.kind).toBe(distillation.kind);

      // Act: the REAL worker, spooling the fixture's distillation.
      const claims = await runWorkerOn(fixture, distillationJson(distillation));

      // Assert: exactly one draft, right kind, draft semantics forced
      // (DESIGN.md §3 Tier 1 — auto/derived/capped, never negotiable).
      expect(claims).toHaveLength(1);
      const claim = claims[0];
      expect(claim?.body.kind).toBe(distillation.kind);
      expect(claim?.body.captureMode).toBe("auto");
      expect(claim?.body.provenance).toBe("derived");
      expect(claim?.body.status).toBe("proposed");
      expect(claim?.body.confidence).toBeLessThanOrEqual(DERIVED_CONFIDENCE_CAP);
      // The actionability pin: a teammate in the same area could act on
      // this body — the fixture names the content that makes it so.
      expect(claim?.body.body.length).toBeLessThanOrEqual(MAX_CLAIM_BODY_LENGTH);
      for (const pin of fixture.bodyPins ?? []) {
        expect(claim?.body.body).toContain(pin);
      }
    });
  }

  for (const fixture of negatives) {
    test(`${fixture.name}: NONE spools nothing`, async () => {
      expect(await runWorkerOn(fixture, "NONE")).toHaveLength(0);
    });
  }

  // Bun's 5 s default is not enough for this one: it runs EVERY positive
  // through the real worker at once, and each of those spawns a process. The
  // per-fixture tests above are the same work one at a time and stay inside
  // the default; this aggregate timed out on a laptop with nothing else
  // running, which reads as a regression rather than as a slow machine.
  const YIELD_TIMEOUT_MS = 60_000;

  test("draft yield holds the floor — every positive spools its draft", async () => {
    const yields = await Promise.all(
      positives.map(async (fixture) => {
        const distillation = fixture.distillation;
        if (distillation === undefined) {
          return false;
        }
        const claims = await runWorkerOn(
          fixture,
          distillationJson(distillation),
        );
        return claims.length === 1 && claims[0]?.body.kind === distillation.kind;
      }),
    );
    const rate = yields.filter(Boolean).length / positives.length;
    expect(rate).toBeGreaterThanOrEqual(FLOOR_CONCLUSION_DRAFT_YIELD);
  }, YIELD_TIMEOUT_MS);
});

describe("conclusion corpus: the prompt names the widened contract", () => {
  // String pins, honestly labeled: the prompt's real precision instrument is
  // the corpus above (the fake runner plays a CORRECT summarizer), and these
  // pins only keep the words that DEFINE correctness from being edited away
  // while the corpus stays green.
  test("asks for conclusions a teammate would act on, not only bug findings", () => {
    expect(SUMMARIZER_PROMPT).toContain("teammate");
    expect(SUMMARIZER_PROMPT).toContain("decision reached");
    expect(SUMMARIZER_PROMPT).toContain("ruled out");
    expect(SUMMARIZER_PROMPT).toContain("review found");
  });

  test("keeps the strictness: no narration, no progress, no plans, no praise", () => {
    expect(SUMMARIZER_PROMPT).toContain("never narrate");
    expect(SUMMARIZER_PROMPT).toContain("Progress reports");
    expect(SUMMARIZER_PROMPT).toContain("plans, and praise");
  });

  test("NONE stays the contract's other half", () => {
    expect(SUMMARIZER_PROMPT).toContain("exactly NONE");
  });

  test("every corpus kind is a kind the prompt offers", () => {
    for (const fixture of positives) {
      expect(SUMMARIZER_PROMPT).toContain(fixture.distillation?.kind ?? "");
    }
  });
});

describe("conclusion predicates (unit)", () => {
  test("verdict language is a declared conclusion, not a plan", () => {
    expect(hasVerdictLanguage("Verdict: the branch is safe to merge")).toBe(true);
    expect(hasVerdictLanguage("Decided to ship 0.6.1 with the holdback on")).toBe(true);
    expect(hasVerdictLanguage("We are going with the spool-flush pattern")).toBe(true);
    expect(hasVerdictLanguage("Decision: holdback stays on by default")).toBe(true);
    expect(hasVerdictLanguage("I will start with the gate")).toBe(false);
    expect(hasVerdictLanguage("we should decide this later")).toBe(false);
  });

  test("the bare nouns decision/conclusion are not verdicts (fix-round precision)", () => {
    // Undecided, pending and summary-opener uses fired the v1 gate; the
    // nouns now demand the punctuation a declaration gives them.
    expect(hasVerdictLanguage("waiting on a product decision from Nick")).toBe(false);
    expect(hasVerdictLanguage("The decision on the cache layer is still open")).toBe(false);
    expect(hasVerdictLanguage("no conclusion yet, still bisecting the failure")).toBe(false);
    expect(hasVerdictLanguage("In conclusion, here is where we are")).toBe(false);
    expect(hasVerdictLanguage("the decision-making process is slow")).toBe(false);
    expect(hasVerdictLanguage("Conclusion: the flag was dead code")).toBe(true);
  });

  test("rejection language marks a ruled-out approach", () => {
    expect(hasRejectionLanguage("pre-warming is ruled out — the seal kills it")).toBe(true);
    expect(hasRejectionLanguage("that approach is not viable at this depth")).toBe(true);
    expect(hasRejectionLanguage("polling won't work because the hub is spooled")).toBe(true);
    expect(hasRejectionLanguage("let me rule nothing out yet")).toBe(false);
    expect(hasRejectionLanguage("the request was denied by the proxy")).toBe(false);
  });

  test("sentence-initial capitalized rejections count (fix-round recall)", () => {
    // Disposition tables start entries with the capitalized verb — the v1
    // pattern was the only prose pattern without /i and missed all of these.
    expect(hasRejectionLanguage("Ruled out: cache pre-warming — the seal kills it")).toBe(true);
    expect(hasRejectionLanguage("Rejected the polling approach entirely")).toBe(true);
    expect(hasRejectionLanguage("Dead end — the hub spools every write")).toBe(true);
    expect(hasRejectionLanguage("Not viable at this depth")).toBe(true);
  });

  test("review-finding shapes are recognized the way reviews print them", () => {
    expect(hasReviewFindingShape("Finding 1 (CRITICAL): secret egress")).toBe(true);
    expect(hasReviewFindingShape("the adversarial review confirmed the leak")).toBe(true);
    expect(hasReviewFindingShape("HIGH: the cap is never re-checked")).toBe(true);
    // Lowercase severity words in prose are not findings.
    expect(hasReviewFindingShape("high confidence in this low-risk change")).toBe(false);
    expect(hasReviewFindingShape("we should review this later")).toBe(false);
  });

  test("a findings list is a SIGNAL; a shouted severity or a lone label is not", () => {
    // The fix-round recall MEDIUM: severity + defect statement IS the modal
    // review output, and must fire without any verdict prose beside it.
    expect(hasReviewFindingSignal("Finding 3 (HIGH): the cap is never re-checked")).toBe(true);
    expect(hasReviewFindingSignal("Review complete. HIGH: dedup misses cross-session repeats")).toBe(true);
    // Emphasis is not a finding — bare CRITICAL stays an anchor only.
    expect(hasReviewFindingSignal("It is CRITICAL that we not forget the backup")).toBe(false);
    // A severity label with no review context is a todo, not a finding.
    expect(hasReviewFindingSignal("HIGH: fix the login button tomorrow")).toBe(false);
    expect(hasReviewFindingSignal("we should review this later")).toBe(false);
  });

  test("a suite flip needs BOTH halves — red alone or green alone is not a flip", () => {
    const red = "3 fail — double fire recorded";
    const green = "1658 pass, 0 fail";
    expect(hasSuiteFlip(`${red}\n${green}`)).toBe(true);
    expect(hasSuiteFlip(red)).toBe(false);
    expect(hasSuiteFlip(green)).toBe(false);
    // "0 fail" is green, never red — the count must be strictly positive.
    expect(hasSuiteFlip("0 fail then 0 fail again")).toBe(false);
  });

  test("the flip's red half is failure OUTPUT, not the word error (fix-round precision)", () => {
    // A thrown-error line ("TypeError: …") or a positive count is red; the
    // bare word and an error class inside a passing test's NAME are not.
    expect(hasSuiteFlip("TypeError: cursor is undefined\nfixed — tests are passing now")).toBe(true);
    expect(hasSuiteFlip("Added error handling and the tests are passing now")).toBe(false);
    expect(hasSuiteFlip("✓ handles TypeError in parser\n212 pass\n0 fail")).toBe(false);
    expect(hasSuiteFlip("the connection error should be gone — tests are green")).toBe(false);
  });

  test("commit boundaries: the command, git's summary line, GitHub's merge phrasing", () => {
    expect(hasCommitBoundary('tool_use Bash: {"command":"git commit -m \\"fix\\""}')).toBe(true);
    expect(hasCommitBoundary("[main 5730ea5] chore: 0.6.1")).toBe(true);
    expect(hasCommitBoundary('tool_use Bash: {"command":"gh pr merge 42"}')).toBe(true);
    expect(hasCommitBoundary("Merge pull request #28")).toBe(true);
    expect(hasCommitBoundary("$ git push origin main")).toBe(true);
    expect(hasCommitBoundary("we should commit to this plan")).toBe(false);
    expect(hasCommitBoundary("the git history shows nothing")).toBe(false);
    // A command MENTIONED in prose is a plan, not a commit that happened.
    expect(hasCommitBoundary("then git push it once the docs are done")).toBe(false);
  });

  test("a conclusion moment is signal AND anchor, never signal alone", () => {
    const signalOnly = "Decided to ship the holdback on by default";
    const anchorOnly = 'tool_use Bash: {"command":"bun test"}\n1658 pass';
    expect(isConclusionMoment(signalOnly)).toBe(false);
    expect(isConclusionMoment(anchorOnly)).toBe(false);
    expect(isConclusionMoment(`${anchorOnly}\n${signalOnly}`)).toBe(true);
  });
});
