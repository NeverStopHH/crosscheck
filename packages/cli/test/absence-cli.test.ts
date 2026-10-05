import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { runCli } from "../src/index.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

const MS_PER_DAY = 86_400_000;

const startHub = (absencesBody?: unknown): {
  readonly url: string;
  readonly stop: () => void;
} => {
  const now = Date.now();
  const absences = absencesBody ?? {
    ok: true,
    data: {
      absences: [
        {
          kind: "inactive",
          name: "Robin",
          latestCommitAt: new Date(now - 2 * MS_PER_DAY).toISOString(),
          lastSessionAt: new Date(now - 9 * MS_PER_DAY).toISOString(),
          evidenceCollectedAt: new Date(now).toISOString(),
        },
        {
          kind: "unconnected",
          name: "Sam Stranger",
          latestCommitAt: new Date(now - MS_PER_DAY).toISOString(),
          lastSessionAt: null,
          evidenceCollectedAt: new Date(now).toISOString(),
        },
      ],
    },
  };
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const { pathname } = new URL(request.url);
      if (pathname === "/api/absences") {
        return Promise.resolve(Response.json(absences));
      }
      if (pathname === "/api/presence") {
        return Promise.resolve(
          Response.json({ ok: true, data: { sessions: [] } }),
        );
      }
      return Promise.resolve(
        Response.json({ ok: true, data: {} }),
      );
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => {
      server.stop(true);
    },
  };
};

/** What the pilot's hub held: commits authored as Claude <noreply@anthropic.com>. */
const cloudAgentAbsence = (now: number): Record<string, unknown> => ({
  kind: "unconnected",
  name: "Claude",
  latestCommitAt: new Date(now - 3 * MS_PER_DAY).toISOString(),
  lastSessionAt: null,
  evidenceCollectedAt: new Date(now).toISOString(),
  cloudAgent: "claude-code-web",
});

/** Doctor's WARN and status's line: one sentence, two surfaces. */
const LINKED_SENTENCE =
  "Claude Code on the web's commit identity noreply@anthropic.com is linked " +
  "to a developer on this hub; crosscheck ignores that link, so its commits " +
  "stay an unconnected gap attributed to nobody — an admin should still remove " +
  "it: find the developer in GET /api/developers, then " +
  "DELETE /api/developers/<developerId>/emails/noreply@anthropic.com";

/** How the hub reports a held link: the identity and the row's kind. */
const ALIAS_LINK = { cloudAgent: "claude-code-web", primary: false };
const PRIMARY_LINK = { cloudAgent: "claude-code-web", primary: true };

/** For a PRIMARY row: no route removes one, so no DELETE is offered. */
const PRIMARY_SENTENCE =
  "Claude Code on the web's commit identity noreply@anthropic.com is a " +
  "developer's primary email on this hub; crosscheck ignores it for " +
  "attribution, so its commits stay an unconnected gap attributed to nobody " +
  "— no admin route removes a primary email, so this stays; " +
  "GET /api/developers shows which account holds it";

const paths: string[] = [];
const stops: (() => void)[] = [];

afterEach(async () => {
  for (const stop of stops) {
    stop();
  }
  stops.length = 0;
  await Promise.all(
    paths.map((path) => rm(path, { recursive: true, force: true })),
  );
  paths.length = 0;
});

const fixture = async (
  label: string,
  absencesBody?: unknown,
): Promise<{ readonly repo: string; readonly env: Record<string, string> }> => {
  const hub = startHub(absencesBody);
  stops.push(hub.stop);
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  const home = await makeHome(label);
  paths.push(repo, home);
  return {
    repo,
    env: {
      CROSSCHECK_HOME: home,
      HOME: home,
      CROSSCHECK_HUB_URL: hub.url,
      CROSSCHECK_API_KEY: "test-key",
    },
  };
};

describe("crosscheck status absence lines", () => {
  test("lists both finding kinds under their own heading", async () => {
    // Arrange
    const { repo, env } = await fixture("status-absences");

    // Act
    const result = await runCli(["status"], env, repo);

    // Assert
    expect(result.stdout).toContain("commit authors without a recent session:");
    expect(result.stdout).toContain(
      "- Robin · last commit 2d ago · last reported session 9d ago",
    );
    // 24h, not "1d": formatAge switches to days at AGE_HOURS_BEFORE_DAYS (48h).
    expect(result.stdout).toContain(
      "- Sam Stranger · last commit 24h ago · no crosscheck account for this author",
    );
  });

  test("names Claude Code on the web's commit identity the way the briefing does", async () => {
    // Arrange
    const { repo, env } = await fixture("status-cloud-agent", {
      ok: true,
      data: { absences: [cloudAgentAbsence(Date.now())] },
    });

    // Act
    const result = await runCli(["status"], env, repo);

    // Assert
    expect(result.stdout).toContain(
      "- Claude · last commit 3d ago · the identity Claude Code on the web commits under — crosscheck cannot capture those sessions, and git does not name who started them",
    );
    expect(result.stdout).not.toContain("crosscheck account");
  });

  test("says when the hub has Claude Code on the web's identity linked to a developer", async () => {
    // Arrange: no absence line at all — a link can close the very gap that
    // would have printed one, so the warning cannot ride on that section
    const { repo, env } = await fixture("status-linked-cloud-agent", {
      ok: true,
      data: { absences: [], linkedCloudAgents: [ALIAS_LINK] },
    });

    // Act
    const result = await runCli(["status"], env, repo);

    // Assert
    expect(result.stdout).toContain(`cloud agent identity: ${LINKED_SENTENCE}`);
  });

  test("the line after the absence section keeps its spelling: `spool: N pending`", async () => {
    // Arrange: an absence line and a linked identity, both printed above it
    const { repo, env } = await fixture("status-spool-spelling", {
      ok: true,
      data: {
        absences: [cloudAgentAbsence(Date.now())],
        linkedCloudAgents: [ALIAS_LINK],
      },
    });

    // Act
    const result = await runCli(["status"], env, repo);

    // Assert
    expect(result.stdout).toMatch(/^spool: 0 pending, 0 dropped$/m);
  });

  test("prints no linked-identity line when nothing is linked", async () => {
    // Arrange
    const { repo, env } = await fixture("status-unlinked-cloud-agent", {
      ok: true,
      data: { absences: [], linkedCloudAgents: [] },
    });

    // Act
    const result = await runCli(["status"], env, repo);

    // Assert
    expect(result.stdout).not.toContain("cloud agent identity:");
  });

  test("prints no absence section when the hub has no endpoint for it", async () => {
    // Arrange
    const { repo, env } = await fixture("status-degrade", { unexpected: true });

    // Act
    const result = await runCli(["status"], env, repo);

    // Assert
    expect(result.stdout).not.toContain("commit authors without a recent session");
  });
});

describe("crosscheck doctor absence check", () => {
  test("warns with counts per kind when the hub reports findings", async () => {
    // Arrange
    const { repo, env } = await fixture("doctor-absences");

    // Act
    const result = await runCli(["doctor"], env, repo);

    // Assert: counts, never names — `crosscheck status` carries the lines
    expect(result.stdout).toContain("WARN  absence findings");
    expect(result.stdout).toContain("1 hub member");
    expect(result.stdout).toContain("1 without a crosscheck account");
    expect(result.stdout).toContain("crosscheck status");
    expect(result.stdout).not.toContain("Robin");
  });

  test("counts a cloud agent's commit identity apart from authors without an account", async () => {
    // Arrange: a member, a stranger, and Claude Code on the web's identity
    const now = Date.now();
    const { repo, env } = await fixture("doctor-cloud-agent", {
      ok: true,
      data: {
        absences: [
          {
            kind: "inactive",
            name: "Robin",
            latestCommitAt: new Date(now - 2 * MS_PER_DAY).toISOString(),
            lastSessionAt: new Date(now - 9 * MS_PER_DAY).toISOString(),
            evidenceCollectedAt: new Date(now).toISOString(),
          },
          {
            kind: "unconnected",
            name: "Sam Stranger",
            latestCommitAt: new Date(now - MS_PER_DAY).toISOString(),
            lastSessionAt: null,
            evidenceCollectedAt: new Date(now).toISOString(),
          },
          cloudAgentAbsence(now),
        ],
      },
    });

    // Act
    const result = await runCli(["doctor"], env, repo);

    // Assert: all three still counted as no matching reported session
    expect(result.stdout).toContain(
      "3 recent commit authors with no matching reported session " +
        "(1 hub member, 1 without a crosscheck account, 1 cloud agent identity)",
    );
  });

  test("warns when the hub has Claude Code on the web's identity linked to a developer", async () => {
    // Arrange: a link from before the hub refused them
    const { repo, env } = await fixture("doctor-linked-cloud-agent", {
      ok: true,
      data: { absences: [], linkedCloudAgents: [ALIAS_LINK] },
    });

    // Act
    const result = await runCli(["doctor"], env, repo);

    // Assert
    expect(result.stdout).toContain(
      `WARN  cloud agent identity  ${LINKED_SENTENCE}`,
    );
  });

  test("for an identity held as a PRIMARY email, offers no remedy the hub would refuse", async () => {
    // Arrange: the account the old "no crosscheck account" line invited
    const { repo, env } = await fixture("doctor-primary-cloud-agent", {
      ok: true,
      data: { absences: [], linkedCloudAgents: [PRIMARY_LINK] },
    });

    // Act
    const result = await runCli(["doctor"], env, repo);

    // Assert: DELETE …/emails answers 400 for a primary, so it is not offered
    expect(result.stdout).toContain(
      `WARN  cloud agent identity  ${PRIMARY_SENTENCE}`,
    );
    expect(result.stdout).not.toContain("DELETE /api/developers");
  });

  test("says a held identity once, however many times the hub lists it", async () => {
    // Arrange
    const { repo, env } = await fixture("doctor-duplicate-cloud-agent", {
      ok: true,
      data: { absences: [], linkedCloudAgents: [ALIAS_LINK, ALIAS_LINK] },
    });

    // Act
    const doctor = await runCli(["doctor"], env, repo);
    const status = await runCli(["status"], env, repo);

    // Assert
    expect(doctor.stdout.split(LINKED_SENTENCE).length - 1).toBe(1);
    expect(status.stdout.split(LINKED_SENTENCE).length - 1).toBe(1);
  });

  test("says no cloud agent identity is linked when the hub measured none", async () => {
    // Arrange
    const { repo, env } = await fixture("doctor-unlinked-cloud-agent", {
      ok: true,
      data: { absences: [], linkedCloudAgents: [] },
    });

    // Act
    const result = await runCli(["doctor"], env, repo);

    // Assert: and the repo's .mailmap, the other way to hand Claude's
    // commits to a person, is checked beside it
    expect(result.stdout).toContain(
      "PASS  cloud agent identity  none linked to a developer",
    );
    expect(result.stdout).toContain(
      "PASS  cloud agent mailmap  no .mailmap line maps a cloud agent's commit identity to another address",
    );
  });

  test("an older hub's silence on linked identities is 'not measured', never 'none'", async () => {
    // Arrange: the default fixture sends no linkedCloudAgents field
    const { repo, env } = await fixture("doctor-older-hub-links");

    // Act
    const result = await runCli(["doctor"], env, repo);

    // Assert
    expect(result.stdout).toContain(
      "PASS  cloud agent identity  not measured (this hub does not report it)",
    );
  });

  test("passes with 'none' when the hub reports no findings", async () => {
    // Arrange
    const { repo, env } = await fixture("doctor-clean", {
      ok: true,
      data: { absences: [] },
    });

    // Act
    const result = await runCli(["doctor"], env, repo);

    // Assert
    expect(result.stdout).toContain("PASS  absence findings  none");
  });

  test("says 'not measured' when the endpoint is missing, not a warning", async () => {
    // Arrange: unrecognisable envelope = what an older hub's 404 body is
    const { repo, env } = await fixture("doctor-older-hub", {
      unexpected: true,
    });

    // Act
    const result = await runCli(["doctor"], env, repo);

    // Assert
    expect(result.stdout).toContain("PASS  absence findings  not measured");
  });
});
