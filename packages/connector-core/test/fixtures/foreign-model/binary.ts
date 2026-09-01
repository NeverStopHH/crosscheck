/**
 * Makes the foreign model fixture SPAWNABLE.
 *
 * `fake-foreign-model.ts` is the whole of the binary's behaviour and it is
 * checked in; what cannot be checked in is a shebang, because a `.ts` file
 * has no portable one for THIS bun (the same reason every other fake in this
 * repo is a shell wrapper). So the two-line `/bin/sh` shim is written into a
 * temp directory with this machine's bun path baked in, and the shim forwards
 * "$@" — a wrapper that swallowed arguments would hide exactly the tripwire
 * the fixture exists to be.
 */
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const FOREIGN_MODEL_SCRIPT = join(
  import.meta.dir,
  "fake-foreign-model.ts",
);

export interface ForeignModelBinary {
  /** The executable path to put in CROSSCHECK_SUMMARIZER_CMD. */
  readonly path: string;
  /** The temp directory holding it — the caller removes it. */
  readonly dir: string;
}

export const makeForeignModelBinary = async (): Promise<ForeignModelBinary> => {
  const dir = await mkdtemp(join(tmpdir(), "cx-foreign-model-"));
  const path = join(dir, "ox-fake");
  await writeFile(
    path,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FOREIGN_MODEL_SCRIPT)} "$@"\n`,
    "utf8",
  );
  await chmod(path, 0o755);
  return { path, dir };
};
