/**
 * What the DDL-sync suites read bootstrap.sql through: the file itself, and
 * the one guarded `DO $$ … $$;` block that names a given constraint.
 */

/** bootstrap.sql — the DDL a real-Postgres hub runs on every start. */
export const BOOTSTRAP_SQL_URL = new URL("../../src/db/bootstrap.sql", import.meta.url);

/**
 * The one guarded `DO $$ … $$;` block that mentions a given constraint.
 *
 * bootstrap.sql holds several, and it runs top to bottom on every hub start;
 * picking one by its own name is the only extraction that stays correct as
 * blocks are appended below it.
 */
export const guardedBlockNamed = (sql: string, constraintName: string): string => {
  const blocks = sql.match(/DO \$\$[\s\S]*?END\s*\n\$\$;/g) ?? [];
  const matching = blocks.filter((block) => block.includes(constraintName));
  if (matching.length !== 1) {
    throw new Error(
      `expected exactly 1 guarded block naming ${constraintName}, found ${String(matching.length)}`,
    );
  }
  return matching[0] ?? "";
};
