/**
 * The rig that puts a FOREIGN model behind crosscheck's Tier-1 contract and
 * runs the real inference path over it.
 *
 * Nothing here fakes crosscheck. It fakes the MODEL — the one component the
 * contract deliberately does not own — and then drives the genuine detached
 * summarizer worker: a real JSONL transcript on disk, a real session state
 * file, a real spawn of a real executable, a real spool. What the tests read
 * afterwards is what a developer's machine would have on it.
 *
 * The foreign binary and the answer corpus live one package up
 * (connector-core/test/fixtures/foreign-model/) because the pure-parse test
 * reads the same strings: one corpus, two readers, so the parse test and the
 * end-to-end test cannot drift apart.
 *
 * WHY THIS IS SHARED rather than copied per test file, against this repo's
 * usual habit of file-private helpers: two files ride it, and one of them
 * (foreign-model-gap.test.ts) exists to run on the BASE commit and fail
 * there. Its red only says something about the contract test's green if both
 * drive the IDENTICAL rig — a copy that drifted by one field would leave the
 * base-red proof attached to nothing.
 *
 * WHY THE CLAUDE CONNECTOR HOSTS THE END-TO-END TEST. The path from a slice
 * to a spooled draft is core's (derive/summarizer/derive.ts) and is shared by
 * all three connectors, but only a HOST can produce a slice, and Claude's is
 * the one a test can write down exactly: a JSONL transcript read by byte
 * range. Driving it here exercises the shared path with no stubs anywhere
 * between the transcript bytes and the spool line.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { repoKey } from "@crosscheck/connector-core/config/paths.ts";
import { readSpoolLines } from "@crosscheck/connector-core/spool/files.ts";
import { writeSessionState } from "@crosscheck/connector-core/state/session-state.ts";

import { makeHome } from "../../../connector-core/test/helpers.ts";
import { makeForeignModelBinary } from "../../../connector-core/test/fixtures/foreign-model/binary.ts";

export { makeForeignModelBinary };
export {
  FOREIGN_SHAPES,
  foreignShape,
} from "../../../connector-core/test/fixtures/foreign-model/corpus.ts";
export type { ForeignShape } from "../../../connector-core/test/fixtures/foreign-model/corpus.ts";

export const FOREIGN_SESSION_ID = "foreign-model-session-uuid";
const REPO_ID = "github.com/acme/api";
/**
 * Port 1 is unbindable and unreachable, so a hub URL built on it can only
 * ever be a KEY here. The summarizer path never calls a hub — it appends to
 * the spool and the next hook flushes it — and a fixture that pointed at a
 * listening port would hide a regression that started calling one.
 */
const HUB_URL = "http://127.0.0.1:1";

const transcriptLine = (type: string, blocks: unknown[]): string =>
  `${JSON.stringify({ type, message: { role: type, content: blocks } })}\n`;

export interface ForeignFixture {
  readonly home: string;
  readonly transcript: string;
  readonly sliceEnd: number;
  readonly key: string;
  /** Removes the home and the transcript directory. */
  readonly cleanup: () => Promise<void>;
}

/**
 * One live session with a two-line transcript whose slice is a diagnosis
 * moment, so the fire the gate would have allowed is the fire the worker
 * runs. The slice CONTENT decides no assertion in either test — the fake
 * model answers from the corpus, not from what it was shown — but a slice
 * that could never have fired would make the fixture a lie.
 */
export const foreignFixture = async (
  stateOverrides: Record<string, unknown> = {},
): Promise<ForeignFixture> => {
  const home = await makeHome("foreign-model");
  const dir = await mkdtemp(join(tmpdir(), "cx-foreign-turn-"));
  const transcript = join(dir, "transcript.jsonl");
  const content =
    transcriptLine("user", [{ type: "text", text: "why does bun test fail" }]) +
    transcriptLine("assistant", [
      {
        type: "text",
        text: "The root cause is the lease being renewed after it expires",
      },
    ]);
  await writeFile(transcript, content, "utf8");
  await writeSessionState(home, {
    hostSessionKey: FOREIGN_SESSION_ID,
    crosscheckSessionId: `cc_${FOREIGN_SESSION_ID}`,
    workContextId: `wc_cc_${FOREIGN_SESSION_ID}`,
    repoId: REPO_ID,
    repoRoot: dir,
    hubUrl: HUB_URL,
    developerId: "dev_self",
    startedAt: new Date().toISOString(),
    ...stateOverrides,
  });
  return {
    home,
    transcript,
    sliceEnd: Buffer.byteLength(content),
    key: repoKey(HUB_URL, REPO_ID),
    cleanup: async () => {
      await rm(home, { recursive: true, force: true });
      await rm(dir, { recursive: true, force: true });
    },
  };
};

export const foreignWorkerArgs = (
  fixture: ForeignFixture,
): readonly string[] => [
  "--transcript",
  fixture.transcript,
  "--session",
  FOREIGN_SESSION_ID,
  "--slice-start",
  "0",
  "--slice-end",
  String(fixture.sliceEnd),
];

export interface SpooledClaim {
  readonly kind: string;
  readonly producer: {
    readonly sessionId: string;
    readonly agentKind: string;
  };
  readonly body: {
    readonly body: string;
    readonly status: string;
    readonly confidence: number;
    readonly captureMode: string;
    readonly provenance: string;
    readonly workContextId: string;
    readonly evidenceRefs: readonly string[];
  };
}

export const spooledClaims = async (
  fixture: ForeignFixture,
): Promise<readonly SpooledClaim[]> =>
  (await readSpoolLines(fixture.home, fixture.key))
    .map((line) => JSON.parse(line) as SpooledClaim)
    .filter((record) => record.kind === "claim");
