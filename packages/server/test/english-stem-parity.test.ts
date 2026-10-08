/**
 * THE ENGLISH STEM IS THE DATABASE'S (hold-out review round 3, follow-up). The
 * content floor matches words on `@crosscheck/schema` englishStem, on the hub
 * and in a connector recounting an old hub alike, while the hub's ranking and
 * its known-terms probe still match on PostgreSQL's english lexemes. They
 * agree only while the stem IS the database's, so it is pinned here, word for
 * word, against ts_lexize('english_stem', …): every word of the labelled
 * corpus — its prompts and its trees — and every closed-class word, whose
 * inflections L1 turns away. (A sweep of a 234 329-word English dictionary
 * found no difference when the port was written.)
 */
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { CLOSED_CLASS_WORDS, englishStem } from "@crosscheck/schema";

import { CORPUS_TREES, PROMPT_CORPUS } from "../../schema/test/fixtures/prompt-corpus.ts";
import { createTestHarness } from "./helpers.ts";

/** The words of a text, lower-cased; a word with a digit is the simple dictionary's, never stemmed. */
const wordsOf = (text: string): readonly string[] =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => /^\p{L}+$/u.test(word));

const VOCABULARY: readonly string[] = [
  ...new Set([
    ...PROMPT_CORPUS.flatMap((row) => wordsOf(row.prompt)),
    ...CORPUS_TREES.flatMap((tree) => [tree.title, tree.description, ...tree.claims, ...(tree.drafts ?? [])].flatMap(wordsOf)),
    ...CLOSED_CLASS_WORDS,
  ]),
].sort();

describe("the english stem, word for word against the database", () => {
  test("every corpus and closed-class word stems as ts_lexize('english_stem') does", async () => {
    // Arrange
    const { db } = await createTestHarness();

    // Act
    const result = await db.execute<{ word: string; lexemes: string[] | null }>(sql`
      SELECT word, ts_lexize('english_stem', word) AS lexemes
      FROM unnest(ARRAY[${sql.join(VOCABULARY.map((word) => sql`${word}`), sql`, `)}]::text[]) AS word`);
    const stemmed = result.rows.filter((row) => row.lexemes !== null && row.lexemes.length > 0);
    const differing = stemmed
      .filter((row) => englishStem(row.word) !== row.lexemes?.[0])
      .map((row) => `${row.word}: database ${String(row.lexemes?.[0])}, schema ${englishStem(row.word)}`);

    // Assert
    // 793 words at the time of writing: a guard against an empty vocabulary.
    expect(stemmed.length).toBeGreaterThan(700);
    expect(differing).toEqual([]);
  });
});
