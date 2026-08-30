/**
 * The tool registry: one entry per tool, and the dispatch `tools/call` uses.
 *
 * A tool is a `{definition, run}` pair, so `tools/list` and `tools/call` read
 * the SAME array and cannot disagree about which tools exist.
 */
import { MAX_ID_CHARS } from "../../constants.ts";
import { toolFailure } from "../protocol.ts";
import type { ToolResult } from "../protocol.ts";
import type { McpContext } from "../context.ts";
import { quoted, quotingText } from "../render.ts";
import * as answerQuestion from "./answer-question.ts";
import * as askTeammate from "./ask-teammate.ts";
import * as extendDiagnosis from "./extend-diagnosis.ts";
import * as getDiagnosis from "./get-diagnosis.ts";
import * as getRefereeBrief from "./get-referee-brief.ts";
import * as listOpenQuestions from "./list-open-questions.ts";
import * as publishClaim from "./publish-claim.ts";
import * as reviewDraft from "./review-draft.ts";
import * as searchRelatedWork from "./search-related-work.ts";
import * as setIntent from "./set-intent.ts";

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface McpTool {
  readonly definition: ToolDefinition;
  readonly run: (ctx: McpContext, args: unknown) => Promise<ToolResult>;
}

/**
 * VERIFY: bun -e 'const {TOOLS}=await import("./packages/connector-core/src/mcp/tools/index.ts");console.log(TOOLS.length, TOOLS.map((t)=>t.definition.name).join(" "))'
 * PRINTS: 10 publish_claim set_intent review_draft extend_diagnosis get_diagnosis get_referee_brief search_related_work ask_teammate answer_question list_open_questions
 */
export const TOOLS: readonly McpTool[] = [
  publishClaim,
  setIntent,
  reviewDraft,
  extendDiagnosis,
  getDiagnosis,
  getRefereeBrief,
  searchRelatedWork,
  // The asynchronous question channel (roadmap R2), listed after the pull
  // tools because that is the order an agent meets them: read what is
  // recorded first, ask only what the record does not answer.
  askTeammate,
  answerQuestion,
  listOpenQuestions,
];

export const findTool = (name: string): McpTool | undefined =>
  TOOLS.find((tool) => tool.definition.name === name);

/**
 * An unknown tool name is a failure the AGENT sees, with the real list in it.
 *
 * The name is quoted for the reason `notFoundText` gives: it is the CALLER's
 * string, an agent picks tool names out of text it has read, and echoing one
 * verbatim would let a claim body have crosscheck repeat it as its own sentence.
 * There is nothing to protect by printing it bare — a name that matched no tool
 * is not one to call again.
 */
export const unknownToolResult = (name: string): ToolResult =>
  toolFailure(
    quotingText(
      `crosscheck has no tool named ${quoted(name, MAX_ID_CHARS)}.`,
      `It has: ${TOOLS.map((tool) => tool.definition.name).join(", ")}.`,
    ),
  );
