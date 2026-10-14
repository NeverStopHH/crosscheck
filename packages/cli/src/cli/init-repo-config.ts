/**
 * What `crosscheck init` leaves in `.crosscheck.json` — the TEAM's committed
 * file (DESIGN.md §2.1), not init's. Init owns exactly two fields of it:
 * `hubUrl` and `protocol`. Everything else — `authoritativeGenerated`,
 * `landingBranches`, `landingFetch`, any field a later release adds — the
 * team wrote, and init used to delete it on every re-run by writing a fresh
 * two-field object over the file.
 *
 * So init MERGES: the file as it stands, with only its own two fields brought
 * up to date, each in the place it already holds (a missing one is appended,
 * so a fresh repo gets exactly the file it always got). And it changes them
 * only when asked:
 *   - `hubUrl` only when the hub this run resolved is a DIFFERENT hub — a
 *     spelling that normalizes to the same one (a trailing slash) is kept;
 *   - `protocol` only when it is not this connector's.
 * When neither changes the file is not written at all, so a re-run leaves it
 * byte for byte — the team's own formatting included — and the git diff shows
 * only real changes. A file that IS rewritten is rendered like every other
 * init file (init-io.ts renderJsonFile).
 *
 * A file init cannot merge onto — unreadable, not JSON, not an object — is
 * refused by the caller through readJsonConfig before anything is written,
 * like `.claude/settings.json` and `.mcp.json`: writing over it would delete
 * the team's fields along with the broken bytes. No original is saved: the
 * only values a merge can replace are init's own two, and the file is
 * committed.
 */
import { PROTOCOL_VERSION } from "@crosscheck/schema";
import { normalizeHubUrl } from "@crosscheck/connector-core/config/config.ts";

import { renderJsonFile } from "./init-io.ts";

/** The fields of `.crosscheck.json` init owns, as this run would set them. */
const ownedFields = (
  existing: Readonly<Record<string, unknown>>,
  hubUrl: string,
): Readonly<Record<string, string>> => {
  const current = existing["hubUrl"];
  const sameHub = typeof current === "string" && normalizeHubUrl(current) === hubUrl;
  return { hubUrl: sameHub ? current : hubUrl, protocol: PROTOCOL_VERSION };
};

/**
 * The content init writes to `.crosscheck.json`, or null when the file
 * already says it and must be left untouched. `existing` and `raw` are what
 * readJsonConfig returned (`raw` null: there is no file yet).
 */
export const plannedRepoConfig = (
  existing: Readonly<Record<string, unknown>>,
  raw: string | null,
  hubUrl: string,
): string | null => {
  const owned = ownedFields(existing, hubUrl);
  const unchanged = Object.entries(owned).every(([key, value]) => existing[key] === value);
  if (raw !== null && unchanged) {
    return null;
  }
  return renderJsonFile({ ...existing, ...owned });
};
