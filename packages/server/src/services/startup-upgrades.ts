/**
 * THE START-UP UPGRADE PASSES, ONE AFTER ANOTHER BUT NEVER ON ONE ANOTHER
 * (review round 4, L3).
 *
 * After the hub is serving (index.ts) it runs, in the background:
 *   1. the draft link cleanup (draft-link-cleanup.ts),
 *   2. the doc upgrade (doc-upgrade.ts),
 *   3. with an embedder, the vector backfill (embedding-backfill.ts).
 * They used to be one promise chain, so a cleanup that threw skipped the doc
 * upgrade, and one error line covered all of them. Each now runs whatever
 * the one before it did — none needs another's result — and each logs its
 * own outcome or its own error. Each is idempotent: the next start retries
 * whatever failed.
 */
import type { Db } from "../db/client.ts";
import { upgradeNormalizedDocs } from "./doc-upgrade.ts";
import type { DocUpgradeReport } from "./doc-upgrade.ts";
import { describeDraftLinkCleanup, removeCrossDeveloperDraftLinks } from "./draft-link-cleanup.ts";
import type { DraftLinkCleanupReport } from "./draft-link-cleanup.ts";
import { backfillEmbeddings } from "./embedding-backfill.ts";
import type { EmbedOutcome } from "./embedding-backfill.ts";
import type { Embedder } from "./embedder.ts";

export interface StartupLog {
  readonly info: (line: string) => void;
  readonly error: (line: string, error: unknown) => void;
}

const CONSOLE_LOG: StartupLog = {
  info: (line) => {
    console.log(line);
  },
  error: (line, error) => {
    console.error(line, error);
  },
};

export interface StartupUpgradeReport {
  /** Null when the pass failed (its error is logged). */
  readonly links: DraftLinkCleanupReport | null;
  readonly docs: DocUpgradeReport | null;
  /** Null without an embedder, or when the pass failed. */
  readonly vectors: EmbedOutcome | null;
}

interface Pass<T> {
  readonly name: string;
  readonly onFailure: string;
  readonly run: () => Promise<T>;
  readonly describe: (result: T) => string;
}

/** Runs one pass; its outcome or its error goes to the log, never to the caller. */
const runPass = async <T>(log: StartupLog, pass: Pass<T>): Promise<T | null> => {
  try {
    const result = await pass.run();
    log.info(`[crosscheck] ${pass.name}: ${pass.describe(result)}`);
    return result;
  } catch (error) {
    log.error(`[crosscheck] ${pass.name} failed; ${pass.onFailure}`, error);
    return null;
  }
};

const describeDocUpgrade = (docs: DocUpgradeReport): string =>
  `${String(docs.contexts)} work context doc(s) rebuilt without drafts, ${String(docs.stamped)} stamped current, ` +
  `${String(docs.reembedded)} re-embedded` +
  (docs.embedFailures === 0 ? "" : `, ${String(docs.embedFailures)} embed failure(s) left for the vector backfill`);

const describeBackfill = (vectors: EmbedOutcome): string =>
  `${String(vectors.embedded)} work context(s) embedded, ${String(vectors.failed)} failed`;

export const runStartupUpgrades = async (deps: {
  readonly db: Db;
  readonly embedder: Embedder | null;
  readonly log?: StartupLog;
}): Promise<StartupUpgradeReport> => {
  const { db, embedder } = deps;
  const log = deps.log ?? CONSOLE_LOG;
  // The doc upgrade's start and progress lines (review round 4, M2).
  const docUpgradeProgress = (line: string): void => {
    log.info(`[crosscheck] doc upgrade: ${line}`);
  };
  const links = await runPass(log, {
    name: "draft link cleanup",
    onFailure: "the next start retries it",
    run: () => removeCrossDeveloperDraftLinks(db),
    describe: describeDraftLinkCleanup,
  });
  const docs = await runPass(log, {
    name: "doc upgrade",
    onFailure: "the next start resumes it",
    run: () => upgradeNormalizedDocs({ db, embedder }, { progress: docUpgradeProgress }),
    describe: describeDocUpgrade,
  });
  const vectors =
    embedder === null
      ? null
      : await runPass(log, {
          name: "vector backfill",
          onFailure: "the next start retries it",
          run: () => backfillEmbeddings({ db, embedder }),
          describe: describeBackfill,
        });
  return { links, docs, vectors };
};
