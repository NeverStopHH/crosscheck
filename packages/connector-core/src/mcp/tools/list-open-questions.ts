/**
 * `list_open_questions` — what teammates have asked THIS developer and are
 * still waiting for (roadmap R2).
 *
 * WHY ITS OWN TOOL, rather than folded into an existing one. The spec left
 * the choice open; the argument against folding is that every other pull tool
 * answers exactly the question it was asked. `search_related_work` answers a
 * TOPIC query, and a topic search that sometimes also returned the caller's
 * mailbox would be a tool whose answer depends on something the caller did
 * not ask about — the reason Stack Overflow keeps answers out of comments and
 * the reason a briefing block is not a search result. Two more concrete
 * reasons: the briefing block is bounded at MAX_QUESTION_POINTERS, so an
 * agent that reads "+2 more not shown" needs a call that lists them; and a
 * session that started before a question arrived has no briefing to re-read.
 *
 * It is a PULL of addressed communication, so a mute does not filter it —
 * mute suppresses a developer's content on the reader's UNASKED surfaces and
 * has never been a boundary (DESIGN.md §2.1). The briefing block is the
 * unasked surface; this is the deliberate pull, exactly like `get_diagnosis`
 * on a muted teammate's tree.
 */
import { z } from "zod";

import { MAX_QUESTION_POINTERS } from "../../constants.ts";
import { toolText } from "../protocol.ts";
import type { ToolResult } from "../protocol.ts";
import type { McpContext } from "../context.ts";
import { QUOTED_DATA_NOTICE } from "../../briefing/render.ts";
import { formatQuestionEntry } from "../../briefing/questions.ts";
import { getQuestions } from "../../http/hub.ts";
import type { InboxQuestion } from "../../http/hub.ts";
import { hubFailure, parseArgs } from "./shared.ts";

/**
 * More than the briefing shows, because this is the call an agent makes
 * precisely when the briefing said there were more. Still bounded — the hub
 * caps its own listing at MAX_QUESTIONS_LISTED and this never prints more
 * than it asks for.
 */
export const MAX_LISTED_QUESTIONS = 10;

/** The briefing shows fewer; this is the call that shows the rest. */
export const BRIEFING_BLOCK_SIZE = MAX_QUESTION_POINTERS;

export const ArgsSchema = z.object({});

export const definition = {
  name: "list_open_questions",
  description:
    "List the questions teammates have asked you through crosscheck and are still " +
    "waiting for, with the id that answers each one. Your SessionStart briefing " +
    "shows the newest few; call this when it said there were more, when this " +
    "session started after a question arrived, or before you finish a piece of " +
    "work somebody asked about. Answer one with answer_question.",
  inputSchema: z.toJSONSchema(ArgsSchema) as Record<string, unknown>,
};

/**
 * SAID OUT LOUD rather than returned as an empty list, the same rule the
 * empty filtered search follows: an empty list and a hub that answered
 * nothing look identical to a reader, and only one of them means "nothing to
 * do".
 */
export const NO_OPEN_QUESTIONS =
  "No teammate is waiting on a question from you on this repo. crosscheck says " +
  "so rather than answering with an empty list, because an empty list and a hub " +
  "that had nothing to say read the same way.";

/**
 * A degraded state gets its OWN sentence, never the calm one. Rows that
 * arrived and could not be vouched for — a body that sanitizes to nothing, an
 * id outside the allowlist — are not the same fact as an empty inbox, and
 * telling a developer "nobody is waiting" when three people are is the worst
 * sentence this tool could produce.
 */
export const unrenderableQuestions = (count: number): string =>
  `${String(count)} question${count === 1 ? " is" : "s are"} waiting for you, and crosscheck ` +
  `would not show ${count === 1 ? "it" : "any of them"}: the text or the id did not survive ` +
  "the checks it runs on anything another developer wrote. Read them on the hub's web " +
  "view, or ask the person to send the question again.";

/**
 * The rendered list, as a pure function of the rows and the clock — split
 * from `run` so the §4.4 registry can attack it with the injection corpus
 * without standing up a hub (the same split `renderSearchResults` has).
 * Every framed value comes from `formatQuestionEntry`; everything else on
 * these lines is a renderer-owned literal.
 *
 * "" means NOTHING RENDERABLE, and the caller decides which of the two
 * reasons to say out loud — an empty inbox, or rows this renderer refused.
 * Returning the calm sentence from here would have made that impossible and
 * would have put a framed surface's output on a line with no quoted-data
 * notice on it, which the §4.4 registry catches.
 */
export const renderOpenQuestions = (
  inbox: readonly InboxQuestion[],
  now: Date,
): string => {
  const entries = inbox
    .flatMap((question) => {
      const entry = formatQuestionEntry(question, now);
      return entry === null ? [] : [entry];
    })
    .slice(0, MAX_LISTED_QUESTIONS);
  if (entries.length === 0) {
    return "";
  }
  const hidden = inbox.length - entries.length;
  const header =
    `${String(entries.length)} question${entries.length === 1 ? "" : "s"} ` +
    `${entries.length === 1 ? "is" : "are"} waiting for an answer from you. ` +
    QUOTED_DATA_NOTICE;
  const more =
    hidden > 0
      ? [
          `(+${String(hidden)} more not shown; answering these first is what makes room)`,
        ]
      : [];
  return [header, ...entries, ...more].join("\n");
};

export const run = async (
  ctx: McpContext,
  args: unknown,
): Promise<ToolResult> => {
  const parsed = parseArgs(ArgsSchema, args, definition.name);
  if (!parsed.ok) {
    return parsed.result;
  }
  // The PULL shape: no mute filter. A mute suppresses a teammate from the
  // reader's unasked surfaces — the briefing block — and has never been a
  // boundary; this tool is the deliberate ask, like get_diagnosis.
  const fetched = await getQuestions(ctx.hub, ctx.identity.repoId, {
    answerable: true,
  });
  if (!fetched.ok) {
    return hubFailure(ctx, fetched);
  }
  const rendered = renderOpenQuestions(fetched.data.inbox, ctx.now());
  if (rendered.length === 0) {
    return toolText(
      fetched.data.inbox.length === 0
        ? NO_OPEN_QUESTIONS
        : unrenderableQuestions(fetched.data.inbox.length),
    );
  }
  return toolText(rendered);
};
