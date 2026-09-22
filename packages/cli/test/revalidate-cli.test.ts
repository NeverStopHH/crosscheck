/**
 * `crosscheck revalidate` — D5's default, and the cost it pays off.
 *
 * Revalidation happens where somebody asks for it. The MCP trigger asks
 * inside `get_diagnosis`, which means a repo NOBODY PULLS A DIAGNOSIS FROM is
 * never revalidated and every claim in it reads `unknown` forever — D5's own
 * named cost, and the reason its default is "both, the CLI manual".
 *
 * WHAT IT PRINTS IS COUNTS, and that is a decision rather than an omission.
 * The command walks a bounded page of this repo's work contexts, spends the
 * same bounded git budget the pull leg does, reports what it measured and
 * names the cut. It prints no claim id, no claim body, no path and no
 * teammate: the question it answers is "how much of what we know still holds
 * against this code", and the sentences behind a downgrade are one
 * `get_diagnosis` away, where a reader asked for them.
 *
 * NOTHING BLOCKS AND NOTHING IS VOUCHED FOR ON A FAILURE. A hub that cannot
 * be reached, a checkout with no default branch, a tree from another repo —
 * each ends with a sentence and an exit code, never with a claim marked
 * current on the strength of a measurement nobody took.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { runCli } from "../src/cli/index.ts";
import { renderRevalidation } from "../src/cli/revalidate.ts";
import {
  git,
  makeHome,
  makeRepo,
  writeRepoFile,
} from "../../connector-core/test/helpers.ts";

const SURFACE = "src/auth/verify.ts";
const ISO = "2026-08-10T08:00:00.000Z";
const HTTP_SERVER_ERROR = 500;

const paths: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];

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

interface Tree {
  readonly id: string;
  readonly observedAtCommit: string | null;
}

interface HubOptions {
  readonly trees: readonly Tree[];
  /** Every route answers 500: a hub that broke, not a hub that said "none". */
  readonly unreachable?: boolean;
  /** Reports the hub accepted, for the assertions about what was spent. */
  readonly reports: Record<string, unknown>[];
}

const diagnosisFor = (tree: Tree): Record<string, unknown> => ({
  repo: "github.com/acme/api",
  workContext: {
    id: tree.id,
    sessionId: "ses_01",
    title: "Login 500s on staging",
    status: "analyzing",
    createdAt: ISO,
  },
  claims:
    tree.observedAtCommit === null
      ? []
      : [
          {
            id: `clm_${tree.id}`,
            workContextId: tree.id,
            authorSessionId: "ses_01",
            authorDeveloperId: "dev_nick",
            authorDeveloperName: "Nick",
            kind: "root_cause",
            body: "The rotated key is dropped before the retry",
            status: "likely_root_cause",
            confidence: 0.8,
            captureMode: "agent",
            provenance: "declared",
            dedupCount: 1,
            evidenceRefs: [],
            createdAt: ISO,
            validity: {
              state: "unknown",
              observedAtCommit: tree.observedAtCommit,
              commitBinding: "reported",
              basis: null,
              touchingCommits: [],
              touchingTotal: null,
              lastRevalidatedAt: null,
              supersededByClaimId: null,
            },
            affectedPaths: [SURFACE],
          },
        ],
  edges: [],
  externalClaims: [],
  targets: [{ kind: "file", value: SURFACE }],
  targetsReported: true,
  droppedRows: 0,
});

const hubWith = (options: HubOptions): string => {
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      if (options.unreachable === true) {
        return Response.json(
          {
            ok: false,
            error: { code: "internal", message: "database is down" },
          },
          { status: HTTP_SERVER_ERROR },
        );
      }
      const { pathname } = new URL(request.url);
      if (pathname === "/api/work-contexts") {
        return Response.json({
          ok: true,
          data: {
            workContexts: options.trees.map((tree) => ({
              id: tree.id,
              developerId: "dev_nick",
              developerName: "Nick",
              title: "Login 500s on staging",
              status: "analyzing",
              createdAt: ISO,
              claimCount: 1,
              targetCount: 1,
            })),
          },
        });
      }
      const tree = options.trees.find(
        (candidate) =>
          pathname === `/api/work-contexts/${candidate.id}/diagnosis`,
      );
      if (tree !== undefined) {
        return Response.json({ ok: true, data: diagnosisFor(tree) });
      }
      if (pathname === "/api/claim-revalidations") {
        const body = (await request.json()) as Record<string, unknown>;
        options.reports.push(body);
        const entries = body["entries"] as { claimId: string }[];
        return Response.json({
          ok: true,
          data: {
            recorded: entries.length,
            refusedDowngrades: 0,
            pruned: 0,
            validities: Object.fromEntries(
              entries.map((entry) => [
                entry.claimId,
                {
                  state: "stale",
                  observedAtCommit: "a1b2c3d",
                  commitBinding: "reported",
                  basis: "declared",
                  touchingCommits: ["deadbee"],
                  touchingTotal: 1,
                  lastRevalidatedAt: ISO,
                  supersededByClaimId: null,
                },
              ]),
            ),
          },
        });
      }
      return Response.json({ ok: true, data: { sessions: [] } });
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${String(server.port)}`;
};

interface LandedRepo {
  readonly root: string;
  readonly observed: string;
}

/** A repo whose surface moved once and landed on the default branch. */
const repoWithLandedRewrite = async (): Promise<LandedRepo> => {
  const root = await makeRepo("revalidate-cli", {
    remote: "git@github.com:acme/api.git",
  });
  paths.push(root);
  await writeRepoFile(root, SURFACE, "export const v = 1;\n");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-m", "surface"]);
  const first = Bun.spawnSync({
    cmd: ["git", "rev-parse", "--short", "HEAD"],
    cwd: root,
  });
  await writeRepoFile(root, SURFACE, "export const v = 2;\n");
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-m", "rewrite"]);
  await git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  return { root, observed: first.stdout.toString().trim() };
};

const run = async (
  root: string,
  hubUrl: string,
): Promise<{ stdout: string; exitCode: number }> => {
  const home = await makeHome("revalidate-cli");
  paths.push(home);
  return runCli(
    ["revalidate"],
    {
      CROSSCHECK_HOME: home,
      HOME: home,
      CROSSCHECK_HUB_URL: hubUrl,
      CROSSCHECK_API_KEY: "test-key",
      CROSSCHECK_TIMEOUT_MS: "4000",
    },
    root,
  );
};

describe("a repo nobody pulls a diagnosis from can be revalidated by hand", () => {
  test("it measures this repo's trees and reports what it spent", async () => {
    // Arrange: two trees, each holding one claim bound to a commit whose
    // surface has since been rewritten on the default branch.
    const { root, observed } = await repoWithLandedRewrite();
    const reports: Record<string, unknown>[] = [];
    const hubUrl = hubWith({
      trees: [
        { id: "wc_one", observedAtCommit: observed },
        { id: "wc_two", observedAtCommit: observed },
      ],
      reports,
    });

    // Act
    const result = await run(root, hubUrl);

    // Assert: both trees measured, both claims reported, and the sentence
    // names the denominator rather than only the numerator.
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("2 of 2");
    expect(reports).toHaveLength(2);
    expect(result.stdout).toContain("stale");
  });

  test("it prints counts and never a claim's body, id or path", async () => {
    // Arrange: data minimisation, and the anchoring asymmetry — the reader
    // typed a health question, not a request for somebody's reasoning.
    const { root, observed } = await repoWithLandedRewrite();
    const hubUrl = hubWith({
      trees: [{ id: "wc_one", observedAtCommit: observed }],
      reports: [],
    });

    // Act
    const result = await run(root, hubUrl);

    // Assert
    expect(result.stdout).not.toContain("clm_wc_one");
    expect(result.stdout).not.toContain("rotated key");
    expect(result.stdout).not.toContain(SURFACE);
  });

  test("a tree with nothing bound is counted, never silently skipped", async () => {
    // Arrange: §8.5's refusal on this surface. A tree whose claims are bound
    // to no commit cannot be measured, and a command that simply left it out
    // of both numbers would report perfect coverage of a repo it never read.
    const { root } = await repoWithLandedRewrite();
    const reports: Record<string, unknown>[] = [];
    const hubUrl = hubWith({
      trees: [{ id: "wc_bare", observedAtCommit: null }],
      reports,
    });

    // Act
    const result = await run(root, hubUrl);

    // Assert: nothing reported to the hub, and the sentence says so.
    expect(reports).toHaveLength(0);
    expect(result.stdout).toContain("0 of 1");
    expect(result.exitCode).toBe(0);
  });

  test("a hub that could not answer vouches for nothing", async () => {
    // Arrange: the failure that must never read as "everything is current".
    const { root } = await repoWithLandedRewrite();
    const hubUrl = hubWith({ trees: [], reports: [], unreachable: true });

    // Act
    const result = await run(root, hubUrl);

    // Assert
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.toLowerCase()).toContain("unknown");
  });

  test("outside a git repository it refuses rather than guessing", async () => {
    // Arrange: the command compares a commit against a working tree, so
    // there is nothing to compare without one.
    const home = await makeHome("revalidate-cli-norepo");
    paths.push(home);
    const hubUrl = hubWith({ trees: [], reports: [] });

    // Act
    const result = await runCli(
      ["revalidate"],
      {
        CROSSCHECK_HOME: home,
        HOME: home,
        CROSSCHECK_HUB_URL: hubUrl,
        CROSSCHECK_API_KEY: "test-key",
      },
      home,
    );

    // Assert
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("repo");
  });
});

describe("the walk's own budget", () => {
  test("trees the time budget did not reach are counted and printed", () => {
    // A bound spent in silence is a coverage claim nobody made. This is
    // separate from `walkWasCut`, which says "there are older trees"; this
    // one says "I ran out of time before these", and the remedy differs.
    const text = renderRevalidation({
      contextsMeasured: 3,
      contextsWalked: 25,
      walkWasCut: false,
      claimsRevalidated: 9,
      groupsCut: 0,
      contextsUnwalked: 22,
      states: { current: 9 },
    });

    expect(text).toContain("22 work contexts were past this run's time budget");
    expect(text).toContain("run it again to reach them");
  });

  test("a walk that finished says nothing about a budget", () => {
    // The control: a line that printed on every run is a line nobody reads.
    const text = renderRevalidation({
      contextsMeasured: 3,
      contextsWalked: 3,
      walkWasCut: false,
      claimsRevalidated: 9,
      groupsCut: 0,
      contextsUnwalked: 0,
      states: { current: 9 },
    });

    expect(text).not.toContain("time budget");
  });

  // WHAT IS NOT GUARDED HERE, said out loud rather than implied by a green
  // file. This harness stubs the hub, so a 25-tree walk finishes in
  // milliseconds: REVALIDATE_WALK_BUDGET_MS is never reached, `unwalked`
  // is always 0, and neither the deadline's firing nor the wiring that
  // carries its count into the report is exercised. Proven rather than
  // assumed — mutating `contextsUnwalked: unwalked` to a literal 0 leaves
  // this file green. What these two cases DO guard is the renderer: the
  // sentence appears when the count is non-zero and stays away when it is
  // not. Closing the rest needs a slow-walk fixture this file does not have,
  // and a test that pretended otherwise would be worse than the gap.
});
