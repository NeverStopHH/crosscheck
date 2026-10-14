/**
 * How a SessionStart hands Claude Code its context: the ONE spelling, used by
 * the handler for the briefing and by the runner for the line that says the
 * briefing was lost (hooks/runner.ts skippedBriefing). Its own module so the
 * runner, which every hook loads, does not pull in the whole handler.
 *
 * `systemMessage` is the PERSON's line (collision-visible): the SessionStart
 * ghost groups the person is told about (hooks/ghost-notice.ts), the one field
 * that reaches the person and not only the model. Absent or empty, the output
 * is the context alone, as the runner's lost-briefing line always is.
 */
export const sessionStartContext = (text: string, systemMessage?: string): string =>
  JSON.stringify({
    ...(systemMessage === undefined || systemMessage.length === 0 ? {} : { systemMessage }),
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: text,
    },
  });
