/**
 * A REAL in-process hub for the handler suites — the ACP capture-harness
 * boot, this package's copy (the harness itself is ACP-wire-specific; only
 * the boot is shared shape). One hub per test file; the label keeps
 * tokens/emails distinct.
 */
import { createDb, createServer } from "@crosscheck/server";

export interface CursorTestHub {
  readonly server: ReturnType<typeof Bun.serve>;
  readonly hubUrl: string;
  readonly apiKey: string;
}

export const bootCursorHub = async (label: string): Promise<CursorTestHub> => {
  const db = await createDb();
  const adminToken = `${label}-admin`;
  const app = createServer({ db, adminToken });
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  const hubUrl = `http://127.0.0.1:${server.port}`;
  const response = await fetch(`${hubUrl}/api/developers`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${adminToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: "Cursor Dev", email: `${label}@example.com` }),
  });
  const body = (await response.json()) as { data: { apiKey: string } };
  return { server, hubUrl, apiKey: body.data.apiKey };
};
