import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseRecord } from "@crosscheck/schema";

import {
  COMMIT_EVIDENCE_WINDOW_DAYS,
  collectCommitEvidence,
  commitEvidenceRecord,
} from "../src/index.ts";
import { makeRepo } from "./helpers.ts";

const NOW = new Date("2026-08-10T12:00:00.000Z");
const MS_PER_DAY = 86_400_000;

const isoAt = (offsetDays: number): string =>
  new Date(NOW.getTime() - offsetDays * MS_PER_DAY).toISOString();

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(
    paths.map((path) => rm(path, { recursive: true, force: true })),
  );
  paths.length = 0;
});

const repo = async (label: string): Promise<string> => {
  const root = await makeRepo(label);
  paths.push(root);
  return root;
};

/** An empty commit authored by `name <email>` at `isoDate` (author + committer). */
const commitAs = async (
  root: string,
  name: string,
  email: string,
  isoDate: string,
): Promise<void> => {
  const proc = Bun.spawn({
    cmd: [
      "git",
      "commit",
      "--allow-empty",
      "-m",
      "work",
      `--author=${name} <${email}>`,
    ],
    cwd: root,
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_DATE: isoDate,
      GIT_COMMITTER_DATE: isoDate,
    },
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`fixture commit failed with ${exitCode}`);
  }
};

describe("collectCommitEvidence", () => {
  test("aggregates one entry per author with the newest timestamp and a count", async () => {
    // Arrange
    const root = await repo("aggregate");
    await commitAs(root, "Robin", "robin@example.com", isoAt(5));
    await commitAs(root, "Robin", "robin@example.com", isoAt(3));
    await commitAs(root, "Alice", "alice@example.com", isoAt(2));
    await commitAs(root, "Robin", "ROBIN@example.com", isoAt(1));

    // Act
    const authors = await collectCommitEvidence(root, NOW);

    // Assert: case-variant emails merge; newest commit wins the timestamp
    expect(authors).not.toBeNull();
    const robin = authors?.find((author) => author.email === "robin@example.com");
    expect(robin?.commitCount).toBe(3);
    expect(robin?.latestCommitAt).toBe(isoAt(1));
    const alice = authors?.find((author) => author.email === "alice@example.com");
    expect(alice?.commitCount).toBe(1);
    expect(alice?.latestCommitAt).toBe(isoAt(2));
  });

  test("ignores commits authored before the scan window", async () => {
    // Arrange
    const root = await repo("window");
    await commitAs(
      root,
      "Old Hand",
      "old@example.com",
      isoAt(COMMIT_EVIDENCE_WINDOW_DAYS + 10),
    );
    await commitAs(root, "Robin", "robin@example.com", isoAt(1));

    // Act
    const authors = await collectCommitEvidence(root, NOW);

    // Assert
    expect(authors?.some((author) => author.email === "old@example.com")).toBe(
      false,
    );
    expect(authors?.some((author) => author.email === "robin@example.com")).toBe(
      true,
    );
  });

  test("drops a commit authored in the future — a forged date is not evidence", async () => {
    // Arrange: author dates are author-controlled free text to git; a date far
    // enough ahead would be stored by the hub as the newest commit forever.
    const root = await repo("future");
    await commitAs(root, "Robin", "robin@example.com", isoAt(1));
    await commitAs(
      root,
      "Forger",
      "victim@example.com",
      new Date(NOW.getTime() + 300 * MS_PER_DAY).toISOString(),
    );

    // Act
    const authors = await collectCommitEvidence(root, NOW);

    // Assert
    expect(authors?.some((author) => author.email === "victim@example.com")).toBe(
      false,
    );
    expect(authors?.some((author) => author.email === "robin@example.com")).toBe(
      true,
    );
  });

  test("keeps a commit within ordinary clock skew ahead of now", async () => {
    // Arrange: thirty seconds ahead — a fast local clock, not a forgery.
    const root = await repo("skew");
    await commitAs(
      root,
      "Robin",
      "robin@example.com",
      new Date(NOW.getTime() + 30_000).toISOString(),
    );

    // Act
    const authors = await collectCommitEvidence(root, NOW);

    // Assert
    expect(authors?.some((author) => author.email === "robin@example.com")).toBe(
      true,
    );
  });

  test("skips bot authors and GitHub noreply emails — automation is not a teammate", async () => {
    // Arrange: a bot commits continuously and can never have an agent session,
    // and the noreply alias surfaces real members as unconnected strangers.
    const root = await repo("bots");
    await commitAs(
      root,
      "renovate[bot]",
      "29139614+renovate[bot]@users.noreply.github.com",
      isoAt(1),
    );
    await commitAs(root, "Nick", "12345+nick@users.noreply.github.com", isoAt(2));
    await commitAs(root, "Robin", "robin@example.com", isoAt(3));

    // Act
    const authors = await collectCommitEvidence(root, NOW);

    // Assert: only the plainly-addressed human remains
    expect(authors?.length).toBe(1);
    expect(authors?.[0]?.email).toBe("robin@example.com");
  });

  test("returns null outside a git repository — fail open, never throw", async () => {
    // Arrange
    const plainDir = await mkdtemp(join(tmpdir(), "cx-no-repo-"));
    paths.push(plainDir);

    // Act
    const authors = await collectCommitEvidence(plainDir, NOW);

    // Assert
    expect(authors).toBeNull();
  });
});

describe("commitEvidenceRecord", () => {
  test("builds an envelope the wire contract accepts", async () => {
    // Arrange
    const root = await repo("record");
    await commitAs(root, "Robin", "robin@example.com", isoAt(1));
    const authors = await collectCommitEvidence(root, NOW);
    expect(authors).not.toBeNull();

    // Act
    const record = commitEvidenceRecord(
      "github.com/acme/api",
      authors ?? [],
      {
        developerId: "dev_1",
        agentKind: "claude-code",
        sessionId: "cc_1",
      },
      NOW,
    );

    // Assert
    const parsed = parseRecord(record);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.unknownKind).toBe(false);
      expect(parsed.envelope.kind).toBe("commit_evidence");
    }
  });
});
