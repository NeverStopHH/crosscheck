/**
 * What a well-formed summarizer answer may still not BE (audit rows M16 /
 * A3-4).
 *
 * `parse.ts` decides whether stdout is a claim-shaped JSON document. It says
 * nothing about what the document contains, and two shapes get through it
 * that are not conclusions at all:
 *
 *   ROLE-PLAY — the model answers as the agent whose turn it just read, and
 *   narrates the next step: "I'll add the retry cap and re-run the suite."
 *   That is a plan, and the prompt says plans are not conclusions; filed as a
 *   `derived` claim it becomes a teammate-visible draft asserting work that
 *   nobody has done. It is the failure mode a tail-degraded slice produces
 *   most (transcript.ts): shown only the last tool outputs and no question,
 *   the likeliest completion is the conversation continuing.
 *
 *   PROMPT ECHO — the model hands the instructions back: "the conclusion as
 *   one sentence, max 400 characters". Well-formed, on-schema, and about
 *   nothing.
 *
 * Both are refused HERE rather than by a better prompt, because a prompt is a
 * request and this is a gate. And both are BOOKED rather than dropped in
 * silence: the fire was already paid for out of the developer's own quota
 * (DESIGN.md §10 risk 7), and a fire whose answer nobody kept must be
 * countable or `doctor` reads the whole class as "the runner is broken"
 * (§4 — fail-open must never mean silently dead).
 *
 * EVERY REASON IS THIS MODULE'S OWN WORDS. None of them quotes the rejected
 * body, and that is deliberate rather than shy: a rejection reason is written
 * into session state and printed by `crosscheck status` and `doctor` into the
 * reader's terminal — often into an agent's context — and pasting a
 * role-played instruction there is exactly what the phrase filter exists to
 * prevent elsewhere.
 */

/** The rejection reasons, as the cost surfaces print them. */
export const REJECTED_ROLE_PLAY =
  "role-play: the answer narrated the next step instead of a conclusion";
export const REJECTED_PROMPT_ECHO =
  "echo: the answer repeated the instructions it was given";
export const REJECTED_HINT_ECHO =
  "echo: the answer was a teammate hint this repo had already delivered";
export const REJECTED_SECRET =
  "dropped: the answer contained something credential-shaped";
export const REJECTED_CONTRACT =
  "rejected: the answer did not satisfy the claim contract";

/**
 * Openers that make a sentence a PLAN or a pleasantry rather than a finding.
 *
 * Narrow on purpose, and the narrowness is the design: past-tense first
 * person is how a real finding is often written ("I found the second flush
 * reads the stale value", "I've confirmed the bucket is shared"), so only
 * FUTURE or INTENT first person is matched, plus the assistant pleasantries
 * no conclusion begins with. A wider list would cost real drafts, and a
 * dropped draft is invisible in a way a bad one is not.
 */
const ROLE_PLAY_OPENERS: readonly RegExp[] = [
  /^i(?:'|’)?ll\b/,
  /^i will\b/,
  /^i(?:'|’)?m (?:going to|about to|now)\b/,
  /^i am (?:going to|about to)\b/,
  /^(?:let me|let(?:'|’)?s)\b/,
  /^(?:next|now|then),? i(?:'|’)?(?:ll|m)?\b/,
  /^here(?:'|’)?s (?:what|how|the plan)\b/,
  /^(?:sure|certainly|of course|okay|ok|great|perfect|absolutely|thanks)\b/,
  /^as (?:an|the) (?:ai|assistant|language model)\b/,
  /^i(?:'|’)?ll? (?:need|have) to\b/,
];

const normalized = (value: string): string =>
  value.toLowerCase().replace(/\s+/g, " ").trim();

/** A plan or a pleasantry, judged on the opening words alone. */
export const isRolePlayAnswer = (body: string): boolean => {
  const text = normalized(body);
  return ROLE_PLAY_OPENERS.some((pattern) => pattern.test(text));
};

/**
 * The instructions, handed back.
 *
 * Substring containment on the NORMALIZED prompt, so spacing and case cannot
 * dodge it, with a length floor: a five-word body that happens to appear in
 * the prompt ("the conclusion itself") is a coincidence, a long one is a
 * copy. The prompt is passed in rather than imported so this module stays a
 * pure predicate and the test can pin the rule with a prompt of its own.
 */
const PROMPT_ECHO_MIN_CHARS = 40;

export const isPromptEcho = (body: string, prompt: string): boolean => {
  const text = normalized(body);
  return (
    text.length >= PROMPT_ECHO_MIN_CHARS && normalized(prompt).includes(text)
  );
};
