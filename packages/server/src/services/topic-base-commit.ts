/**
 * THE BASE COMMIT A WORK CONTEXT'S WORK STANDS ON (DESIGN.md "One session,
 * many topics"): its own, when it is a TOPIC that carried one, else its
 * session's.
 *
 * A session's `base_commit` is its START checkout's HEAD. One long-lived
 * session sat detached at a weeks-old commit and opened a topic in each
 * sibling worktree it edited, every one on a fresh branch: read off the
 * session row, each topic's drift label and freshness were measured from the
 * old commit it never worked on. A context from a connector before topics
 * carries none and reads exactly as it always has.
 */
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { agentSessions, workContexts } from "../db/schema.ts";

export const contextBaseCommit: SQL<string> = sql<string>`coalesce(${workContexts.baseCommit}, ${agentSessions.baseCommit})`;
