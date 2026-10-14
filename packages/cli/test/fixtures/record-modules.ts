/**
 * PRELOAD for a child process under test: at exit, writes every module the
 * process loaded to CX_MODULE_LOG as one JSON array — what test/bin.test.ts
 * reads to prove a hook process loads its own hook and not the CLI, the MCP
 * server or the other hooks (batch-2 review, M6).
 *
 * Read from `require.cache`, which in Bun lists ES modules too, the dynamic
 * imports included (measured on 1.3.13 and 1.4.3: 309 and 299 entries for a
 * PreToolUse process, its handler among them; the CLI path adds
 * cli/src/cli/index.ts). Not from JSC's `globalThis.Loader.registry`: Bun
 * 1.4 no longer has `Loader`, and this file then wrote `[]` for every process.
 */
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const LOG = process.env["CX_MODULE_LOG"] ?? "";

if (LOG.length > 0) {
  const cache = createRequire(import.meta.url).cache;
  process.on("exit", () => {
    writeFileSync(LOG, JSON.stringify(Object.keys(cache)));
  });
}
