/**
 * The SQL docs/OPERATIONS.md gives an operator, exactly as it is written
 * there — so a test runs what the page says, and a page that drifts from the
 * schema fails a test instead of an operator.
 *
 * Each snippet is a ```sql block whose first line is `-- <marker>`.
 */
const OPERATIONS_DOC_URL = new URL("../../../../docs/OPERATIONS.md", import.meta.url);

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const documentedSql = async (marker: string): Promise<string> => {
  const block = new RegExp("```sql\\n(-- " + escapeRegExp(marker) + "\\n[\\s\\S]*?)```");
  const match = (await Bun.file(OPERATIONS_DOC_URL).text()).match(block);
  if (match?.[1] === undefined) {
    throw new Error(`docs/OPERATIONS.md has no \`\`\`sql block starting with -- ${marker}`);
  }
  return match[1];
};
