/**
 * NO SESSION-BEARING RELATION MAY BE SILENT ABOUT RETENTION (1.0 spec 01a
 * §3.3f, CSK-12).
 *
 * The sweep is generated from services/retention-registry.ts and deletes a
 * session's skeleton when no ROOT there reaches it. So a relation that
 * references a session and is missing from the registry is not "ignored" —
 * it is a root the sweep deletes underneath. The check therefore runs in the
 * direction that matters and by FOREIGN KEY, never by column name: every
 * column the DDL declares `REFERENCES agent_sessions(id)`, under whatever
 * name (`opener_session_id`, `owner`, `top_session_id`), must have an entry,
 * and every entry that declines to retain must say why.
 *
 * The DDL read is `bootstrap.sql` — the file every hub actually runs.
 */
import { describe, expect, test } from "bun:test";

import { RETENTION_ROOT_LIVENESS_OWNER, RETENTION_ROOT_NAMES } from "@crosscheck/schema";

import { RETENTION_REGISTRY, retentionRoots } from "../src/services/retention-registry.ts";

const BOOTSTRAP_SQL_URL = new URL("../src/db/bootstrap.sql", import.meta.url);

interface SessionReference {
  readonly table: string;
  readonly column: string;
}

/**
 * Every column the DDL ties to `agent_sessions(id)`: inside a CREATE TABLE
 * body, and in an ALTER TABLE … ADD COLUMN (how a column reaches a hub that
 * already has the table).
 */
/** `REFERENCES agent_sessions`, with or without `(id)` and the space before it. */
const TO_SESSIONS = String.raw`REFERENCES\s+agent_sessions(?:\s*\(\s*id\s*\))?(?![\w])`;

const sessionReferencesIn = (ddl: string): readonly SessionReference[] => {
  const found: SessionReference[] = [];
  const add = (table: string | undefined, columns: string | undefined): void => {
    for (const column of (columns ?? "").split(",").map((name) => name.trim())) {
      if (table !== undefined && column.length > 0) {
        found.push({ table, column });
      }
    }
  };
  for (const block of ddl.matchAll(/CREATE TABLE(?: IF NOT EXISTS)? (\w+) \(([\s\S]*?)\n\);/g)) {
    const [, table, body] = block;
    for (const line of (body ?? "").split("\n")) {
      // An inline reference on a column, or a table-level FOREIGN KEY.
      add(
        table,
        new RegExp(String.raw`^\s+(?!(?:FOREIGN|CONSTRAINT|PRIMARY|UNIQUE|CHECK)\b)(\w+)\s[^,]*${TO_SESSIONS}`).exec(line)?.[1],
      );
      add(table, new RegExp(String.raw`FOREIGN KEY\s*\(([^)]*)\)\s*${TO_SESSIONS}`).exec(line)?.[1]);
    }
  }
  for (const altered of ddl.matchAll(
    new RegExp(String.raw`ALTER TABLE (\w+)\s+ADD COLUMN(?: IF NOT EXISTS)? (\w+)[^;]*${TO_SESSIONS}`, "g"),
  )) {
    add(altered[1], altered[2]);
  }
  for (const constrained of ddl.matchAll(
    new RegExp(String.raw`ALTER TABLE (\w+)\s+ADD CONSTRAINT \w+\s+FOREIGN KEY\s*\(([^)]*)\)\s*${TO_SESSIONS}`, "g"),
  )) {
    add(constrained[1], constrained[2]);
  }
  return found;
};

const key = (reference: SessionReference): string => `${reference.table}.${reference.column}`;

describe("the retention registry against the DDL (CSK-12)", () => {
  test("every column that references a session has a registry entry", async () => {
    // Arrange
    const ddl = await Bun.file(BOOTSTRAP_SQL_URL).text();
    const declared = new Set(RETENTION_REGISTRY.map(key));

    // Act
    const references = sessionReferencesIn(ddl);
    const undeclared = references.map(key).filter((name) => !declared.has(name));

    // Assert — and the enumeration itself found the known ones, so a parser
    // that matched nothing cannot pass by finding nothing undeclared
    expect(undeclared).toEqual([]);
    expect(references.map(key)).toContain("claims.author_session_id");
    expect(references.map(key)).toContain("pilot_attributions.top_session_id");
    expect(references.length).toBeGreaterThanOrEqual(9);
  });

  test("an entry that declines to retain says why", () => {
    // Act
    const unexplained = RETENTION_REGISTRY.filter(
      (relation) => relation.semantics === "non_retaining_edge" && relation.reason.trim().length === 0,
    );

    // Assert
    expect(unexplained).toEqual([]);
  });

  test("every entry names a table the hub has, unless it is declared not built", async () => {
    // Arrange — an entry for a table that does not exist is a root the sweep
    // would fail on every pass, or a declaration nobody can check; a root
    // declared `not_built` is the one entry allowed to be ahead of the DDL,
    // because it stops the sweep until it is built (CSK-26)
    const ddl = await Bun.file(BOOTSTRAP_SQL_URL).text();

    // Act
    const missing = RETENTION_REGISTRY.filter(
      (relation) =>
        !(relation.semantics === "root" && relation.status === "not_built") &&
        !ddl.includes(`CREATE TABLE IF NOT EXISTS ${relation.table} (`),
    ).map(key);

    // Assert
    expect(missing).toEqual([]);
  });

  test("the enumeration sees a reference under any column name", () => {
    // Arrange — the name-matching check revision 3 proposed would miss both
    const ddl = [
      "CREATE TABLE IF NOT EXISTS reviews (",
      "  id text PRIMARY KEY,",
      "  opener text NOT NULL REFERENCES agent_sessions(id)",
      ");",
      "ALTER TABLE reviews ADD COLUMN IF NOT EXISTS owner text REFERENCES agent_sessions(id);",
    ].join("\n");

    // Act & Assert
    expect(sessionReferencesIn(ddl).map(key)).toEqual(["reviews.opener", "reviews.owner"]);
  });

  test("the enumeration sees every spelling of a reference to a session", () => {
    // Arrange — a table-level foreign key, a bare REFERENCES (implicit key),
    // a space before (id), an ALTER without IF NOT EXISTS, and a constraint
    // added later: each is a relation the sweep could delete underneath
    const ddl = [
      "CREATE TABLE IF NOT EXISTS handoffs (",
      "  id text PRIMARY KEY,",
      "  giver text NOT NULL,",
      "  taker text REFERENCES agent_sessions,",
      "  witness text REFERENCES agent_sessions (id),",
      "  FOREIGN KEY (giver) REFERENCES agent_sessions(id)",
      ");",
      "ALTER TABLE handoffs ADD COLUMN auditor text REFERENCES agent_sessions(id);",
      "ALTER TABLE handoffs ADD CONSTRAINT handoffs_owner_fk FOREIGN KEY (owner) REFERENCES agent_sessions(id);",
    ].join("\n");

    // Act & Assert
    expect(sessionReferencesIn(ddl).map(key).sort()).toEqual([
      "handoffs.auditor",
      "handoffs.giver",
      "handoffs.owner",
      "handoffs.taker",
      "handoffs.witness",
    ]);
  });

  test("each root's liveness and its owing spec agree, and every root name is declared once", () => {
    // Arrange — doctor names the owing spec from the schema's map, the sweep
    // reads liveness from the registry; a root that disagreed would print an
    // owner for a rule already defined, or none for one still owed
    const roots = retentionRoots();

    // Act
    const disagreeing = roots.filter(
      (root) =>
        (root.liveness === "undefined_pending_spec") !==
        (RETENTION_ROOT_LIVENESS_OWNER[root.name] !== null),
    );

    // Assert
    expect(disagreeing.map((root) => root.name)).toEqual([]);
    expect(roots.map((root) => root.name).sort()).toEqual([...RETENTION_ROOT_NAMES].sort());
  });
});
