/**
 * PRELOAD for a child process under test: at exit, writes every module the
 * process loaded (Bun's module registry) to CX_MODULE_LOG as one JSON array —
 * what test/bin.test.ts reads to prove a hook process loads its own hook and
 * not the CLI, the MCP server or the other hooks (batch-2 review, M6).
 */
import { writeFileSync } from "node:fs";

const LOG = process.env["CX_MODULE_LOG"] ?? "";

interface LoaderGlobal {
  readonly Loader?: { readonly registry?: ReadonlyMap<string, unknown> };
}

if (LOG.length > 0) {
  process.on("exit", () => {
    const registry = (globalThis as unknown as LoaderGlobal).Loader?.registry;
    writeFileSync(LOG, JSON.stringify(registry === undefined ? [] : [...registry.keys()]));
  });
}
