/**
 * Subprocess body for test/generated-targets.test.ts: one classifyGenerated
 * call under whatever `git` the launching test put first on PATH — a stalled
 * one (helpers.ts `makeStalledGitDir`, run by `runProbeWithGit`) — printed as
 * JSON `[path, classification]` pairs. Its input is the call's own, as JSON,
 * in the first argument.
 *
 * Exits explicitly: the abandoned read of a stalled git must not hold this
 * process open past its answer.
 */
import { classifyGenerated } from "../../src/capture/generated.ts";
import type { ClassifyGeneratedInput } from "../../src/capture/generated.ts";

const input = JSON.parse(process.argv[2] ?? "") as ClassifyGeneratedInput;
const classified = await classifyGenerated(input);
console.log(JSON.stringify([...classified]));
process.exit(0);
