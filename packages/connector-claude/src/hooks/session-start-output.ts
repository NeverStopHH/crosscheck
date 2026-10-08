/**
 * How a SessionStart hands Claude Code its context: the ONE spelling, used by
 * the handler for the briefing and by the runner for the line that says the
 * briefing was lost (hooks/runner.ts skippedBriefing). Its own module so the
 * runner, which every hook loads, does not pull in the whole handler.
 */
export const sessionStartContext = (text: string): string =>
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: text,
    },
  });
