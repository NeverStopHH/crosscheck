/**
 * THE LABELLED PROMPT CORPUS — the quality gate for "does this prompt carry
 * a task" (DESIGN.md §4, review 1006b decision 1). Every row is a prompt, its
 * label, its language and where it came from; connector-core's
 * prompt-corpus-gate.test.ts runs every row through the whole hint pipeline
 * against an in-memory hub seeded with CORPUS_TREES, and asserts ZERO hints
 * on `content_free` rows and at most a named number of false floors on `task`
 * rows. EVERY FUTURE PILOT FINDING BECOMES A ROW HERE.
 *
 * SYNTHETIC TEXT ONLY — no project content — except the one live pilot
 * prompt the tests already carry ("mache weiter, limit zuruckgesetzt …").
 *
 * The trees share the obvious words on purpose: the limit trees say limit,
 * reset, please, continue, mache, bitte, weiter; the checkout tree says next
 * step, continue, try again; the CI tree says monitor, checks, pass. A
 * content-free prompt that leaks one counted word beside another meets a
 * tree that holds both. A `task` row with a `tree` shares at least two
 * content words with that tree, so it MUST arrive as a hint; a `task` row
 * with a `draftOnlyTree` shares them only with a teammate's unreviewed DRAFT
 * there, so it must NOT (draft-nudge review).
 */

export type PromptLabel = "content_free" | "task";
export type PromptLanguage = "de" | "en";
export type PromptSource = "review" | "pilot" | "synthetic";

export interface CorpusTree {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly claims: readonly string[];
  /** Unreviewed derived drafts — invisible to the push path until confirmed. */
  readonly drafts?: readonly string[];
}

export interface CorpusPrompt {
  readonly prompt: string;
  readonly label: PromptLabel;
  readonly language: PromptLanguage;
  readonly source: PromptSource;
  /** A `task` row that shares two content words with this tree: it must be hinted. */
  readonly tree?: string;
  /** A `task` row whose words only a draft in this tree shares: it must not be. */
  readonly draftOnlyTree?: string;
}

export const CORPUS_TREES: readonly CorpusTree[] = [
  {
    id: "wc_usage_limit",
    title: "Usage limit resets too early",
    description: "Per-user usage limit and its reset schedule",
    claims: [
      "The usage limit reset runs at midnight per user; please continue the import once the limit reset has gone through.",
      "The retry limit and the restart counter share one usage budget, so a restart eats retries.",
    ],
  },
  {
    id: "wc_upload_limit",
    title: "Upload-Limit der Trainingsvideos",
    description: "Limit und Usage zurücksetzen, Preset prüfen",
    claims: [
      "Mache das Limit-Handling im Upload robuster, bitte nach dem Reset wiederaufnehmen.",
      "Das Limit wird nicht zurückgesetzt, wenn der Retry abbricht; das Limit neu setzen oder ein Preset-Reset hilft nicht.",
      "Fortsetzung des Uploads nach dem Neustart braucht ein neues Usage-Limit.",
    ],
  },
  {
    id: "wc_checkout_retries",
    title: "Checkout retries double-charge",
    description: "Payment retries and idempotency",
    claims: [
      "Next step is to continue with the idempotency key on retries; try again only after the key is stored.",
      "The checkout test is flaky because retries race the payment webhook.",
    ],
  },
  {
    id: "wc_chunked_upload",
    title: "Chunked Upload",
    description: "Upload in Teilen",
    claims: ["Nächster Schritt: den Upload in Chunks umsetzen, dann weiter mit dem Gateway-Test."],
  },
  {
    id: "wc_worker_dies",
    title: "Worker dies on deploy",
    description: "Queue worker",
    claims: ["The worker dies when SIGTERM arrives mid-batch during a deploy."],
  },
  {
    id: "wc_ci_monitor",
    title: "Monitor CI checks",
    description: "PR checks monitor",
    claims: ["The monitor reports CI checks pass for every PR event and comment."],
  },
  {
    id: "wc_session_idle",
    title: "Session idle timeout logs users out",
    description: "Idle sessions",
    claims: ["The idle session timeout fires after one turn of inactivity; resume the session context after login."],
  },
  {
    id: "wc_db_migration",
    title: "Database migration stalls",
    description: "Orders table",
    claims: ["The database migration stalls on the orders table lock."],
  },
  {
    id: "wc_oauth_refresh",
    title: "OAuth refresh race",
    description: "Token refresh",
    claims: ["Fix the OAuth refresh race by serialising the token refresh per user."],
  },
  {
    id: "wc_flaky_tests",
    title: "Flaky integration tests",
    description: "Shared fixtures",
    claims: ["The integration tests are flaky because the fixtures share one database."],
  },
  {
    id: "wc_export_tests",
    title: "Tests für den PDF-Export",
    description: "Vorlage und Export",
    claims: ["Mache weiter mit den Tests für den PDF-Export, bitte die Vorlage prüfen."],
  },
  {
    id: "wc_task_list",
    title: "Task list shows the current user twice",
    description: "Duplicate rows in the task view",
    claims: ["The current user is joined twice when a task has two assignees."],
  },
  {
    id: "wc_draft_only",
    title: "Nightly report formatting",
    description: "Report layout",
    claims: [],
    drafts: ["The zebrafrobnicator cache poisons the quuxinator on every warm start"],
  },
];

const free = (prompt: string, language: PromptLanguage, source: PromptSource): CorpusPrompt => ({
  prompt,
  label: "content_free",
  language,
  source,
});

const draftOnly = (prompt: string, language: PromptLanguage, draftOnlyTree: string): CorpusPrompt => ({
  prompt,
  label: "task",
  language,
  source: "synthetic",
  draftOnlyTree,
});

const task = (prompt: string, language: PromptLanguage, source: PromptSource, tree?: string): CorpusPrompt => ({
  prompt,
  label: "task",
  language,
  source,
  ...(tree === undefined ? {} : { tree }),
});

const TASK_NOTIFICATION =
  "<task-notification><task-id>bp1v5vsl4</task-id>" +
  '<summary>Monitor event: "PR #74 CI checks for 493ffb4f"</summary>' +
  "<event>Comment claims (macos-latest): pass</event></task-notification>";

/** The review's content-free prompts (review 1006b, M3/H1 probes), verbatim. */
const REVIEW_CONTENT_FREE: readonly CorpusPrompt[] = [
  free("mache weiter", "de", "review"),
  free("mach weiter bitte", "de", "review"),
  free("weiter", "de", "review"),
  free("continue", "en", "review"),
  free("please continue", "en", "review"),
  free("ok continue", "en", "review"),
  free("go on", "en", "review"),
  free("go ahead", "en", "review"),
  free("keep going", "en", "review"),
  free("yes please", "en", "review"),
  free("ja bitte", "de", "review"),
  free("passt, weiter", "de", "review"),
  free("mach weiter, limit zurückgesetzt", "de", "review"),
  free("Limit wieder da, weiter", "de", "review"),
  free("sounds good, do it", "en", "review"),
  free("looks good, ship it", "en", "review"),
  free("lgtm", "en", "review"),
  free("weiter so", "de", "review"),
  free("fahre fort", "de", "review"),
  free("mach da weiter wo du aufgehört hast", "de", "review"),
  free("continue where you left off", "en", "review"),
  free("carry on", "en", "review"),
  free("proceed", "en", "review"),
  free("jo mach", "de", "review"),
  free("alles klar, weiter", "de", "review"),
  free("perfekt, mach weiter", "de", "review"),
  free("super danke, weiter", "de", "review"),
  free("ok cool", "en", "review"),
  free("try again", "en", "review"),
  free("nochmal versuchen", "de", "review"),
  free("versuch es nochmal", "de", "review"),
  free("bitte nochmal probieren", "de", "review"),
  free("retry please", "en", "review"),
  free("once more", "en", "review"),
  free("und weiter", "de", "review"),
  free("okay, then continue with the next step", "en", "review"),
  free("weiter mit dem nächsten Schritt", "de", "review"),
  free("Limit ist wieder frei, du kannst weitermachen", "de", "review"),
  free("the limit has been reset, you can continue now", "en", "review"),
  free("session limit reset, resume", "en", "review"),
  free("go for it", "en", "review"),
  free("do it", "en", "review"),
  free("einverstanden, umsetzen", "de", "review"),
  free("klingt gut, mach so", "de", "review"),
  free("ja, Option 2", "de", "review"),
  // H1: one task word beside the steering words must not let them count
  free("mache weiter mit den Tests, limit zurückgesetzt, bitte", "de", "review"),
  free("please continue with the tests, the limit was reset", "en", "review"),
  // Harness shapes the review found leaking
  free(
    "<ide_opened_file>The user opened the file /repo/src/upload/limit.ts in the IDE. This may or may not be related to the current task.</ide_opened_file>\nmache weiter, limit zurückgesetzt, bitte",
    "de",
    "review",
  ),
  free(
    "<ide_opened_file>The user opened the file /repo/README.md in the IDE. This may or may not be related to the current task.</ide_opened_file>\nok weiter",
    "de",
    "review",
  ),
  free(
    '[Cross-session idle notice] "agentic-main-f0", which you asked to be notified about, is idle now — it finished a turn at 16:14.',
    "en",
    "review",
  ),
  free("<system-reminder>ctx</system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\nMonitor event: PR #74 CI checks pass", "en", "review"),
];

/** What the live pilot pointed on. */
const PILOT_CONTENT_FREE: readonly CorpusPrompt[] = [
  free("mache weiter, limit zuruckgesetzt. bitte alles wiederuafnhemen", "de", "pilot"),
  free("macxhe weiter, limit ist zurukgsetz", "de", "pilot"),
  free(TASK_NOTIFICATION, "en", "pilot"),
  free(`[SYSTEM NOTIFICATION - NOT USER INPUT]\n${TASK_NOTIFICATION}`, "en", "pilot"),
];

const SYNTHETIC_CONTENT_FREE: readonly CorpusPrompt[] = [
  free("contineu please", "en", "synthetic"),
  free("wieter machen bitte", "de", "synthetic"),
  free("mach wieter, das limit ist zurueckgesetzt", "de", "synthetic"),
  free("Limit zuruckgesetzt, du kannst weitermachen", "de", "synthetic"),
  free("okay so the usage limit was reset a few minutes ago, please just continue with whatever you were doing", "en", "synthetic"),
  free("das Limit ist zurückgesetzt, bitte fortfahren", "de", "synthetic"),
  free("session is back, resume where we were", "en", "synthetic"),
  free("please try again, the rate limit is cleared", "en", "synthetic"),
  free("ja passt so, weiter bitte", "de", "synthetic"),
  free("sounds great, go ahead and continue", "en", "synthetic"),
  free("alright, next step please", "en", "synthetic"),
  free("thanks, keep going", "en", "synthetic"),
  free("probier es nochmal", "de", "synthetic"),
  free("ok weiter machen", "de", "synthetic"),
  free(
    "<ide_selection>The user selected the lines 3 to 9 from /repo/src/upload/limit.ts:\nconst limit = await usageLimit();\n</ide_selection>\nweiter",
    "de",
    "synthetic",
  ),
  free("# Autonomous loop tick (dynamic pacing)\nCheck the CI checks and the usage limit reset.", "en", "synthetic"),
  free('<teammate-message teammate_id="researcher">The usage limit reset runs at midnight per user</teammate-message>', "en", "synthetic"),
  free('<agent-message from="a1">Report: the checkout retries test passes now, next step is the idempotency key</agent-message>', "en", "synthetic"),
];

/** The review's task prompts (review 1006b, M3 probe), verbatim. */
const REVIEW_TASKS: readonly CorpusPrompt[] = [
  task("reset usage limits", "en", "review", "wc_usage_limit"),
  task("why does the usage limit reset", "en", "review", "wc_usage_limit"),
  task("when does the limit reset?", "en", "review", "wc_usage_limit"),
  task("retry limit", "en", "review", "wc_usage_limit"),
  task("add a retry limit", "en", "review", "wc_usage_limit"),
  task("carry over limits", "en", "review"),
  task("keep going on usage limits", "en", "review", "wc_usage_limit"),
  task("usage limit resets too early", "en", "review", "wc_usage_limit"),
  task("limit usage", "en", "review", "wc_usage_limit"),
  task("usage reset", "en", "review", "wc_usage_limit"),
  task("reset preset", "en", "review", "wc_upload_limit"),
  task("restart usage", "en", "review", "wc_usage_limit"),
  task("proceed with the reset", "en", "review"),
  task("resume retry", "en", "review"),
  task("keep limits", "en", "review"),
  task("restart everything", "en", "review"),
  task("is the limit reset per user?", "en", "review", "wc_usage_limit"),
  task("continue the migration", "en", "review"),
  task("resume upload", "en", "review"),
  task("resett usage limitz", "en", "review"),
  task("limit resets", "en", "review", "wc_usage_limit"),
  task("reset the limits please", "en", "review", "wc_usage_limit"),
  task("Retry limit reached?", "en", "review", "wc_usage_limit"),
  task("retry limit restart", "en", "review", "wc_usage_limit"),
  task("Continue retry limit", "en", "review", "wc_usage_limit"),
  task("Limit zurücksetzen", "de", "review", "wc_upload_limit"),
  task("Zurücksetzen der Limits", "de", "review", "wc_upload_limit"),
  task("Preset zurücksetzen", "de", "review", "wc_upload_limit"),
  task("Usage-Limit zurücksetzen", "de", "review", "wc_upload_limit"),
  task("Wann wird das Limit zurückgesetzt?", "de", "review", "wc_upload_limit"),
  task("Warum wird das Limit nicht zurückgesetzt?", "de", "review", "wc_upload_limit"),
  task("Mach das Limit-Reset", "de", "review", "wc_upload_limit"),
  task("bitte Usage zurücksetzen", "de", "review", "wc_upload_limit"),
  task("Retry-Limit erhöhen", "de", "review", "wc_usage_limit"),
  task("Limit erneut setzen", "de", "review", "wc_upload_limit"),
  task("Restart erneut", "de", "review"),
  task("Fortsetzung des Uploads", "de", "review", "wc_upload_limit"),
  task("Nochmal das Limit prüfen", "de", "review", "wc_upload_limit"),
  task("Reset-Limit nochmal", "de", "review", "wc_usage_limit"),
  task("Limits einfach zurücksetzen", "de", "review", "wc_upload_limit"),
  task("Limit schon zurückgesetzt?", "de", "review", "wc_upload_limit"),
  task("Mach mal das Retry-Limit", "de", "review", "wc_usage_limit"),
  task("Neustart fortsetzen", "de", "review"),
  task("Zurückgesetztes Limit", "de", "review"),
  task("Retry nochmal", "de", "review"),
  task(
    "Okay, the limit was reset, so please continue and keep going with everything you were doing before, then fix the OAuth refresh race",
    "en",
    "review",
    "wc_oauth_refresh",
  ),
];

const SYNTHETIC_TASKS: readonly CorpusPrompt[] = [
  task("why does the worker die", "en", "synthetic", "wc_worker_dies"),
  task("warum stirbt der worker beim deploy", "de", "synthetic", "wc_worker_dies"),
  task(
    "okay so before we go any further I want to understand why exactly the queue worker dies whenever we deploy during a large batch",
    "en",
    "synthetic",
    "wc_worker_dies",
  ),
  task("fix the oauth refesh race", "en", "synthetic", "wc_oauth_refresh"),
  task("the checkout test is flaky again after the retries change", "en", "synthetic", "wc_checkout_retries"),
  task("Retry-Limit im Checkout erhöhen", "de", "synthetic", "wc_checkout_retries"),
  task("db migration stalls on the orders table", "en", "synthetic", "wc_db_migration"),
  task("continue the database migration on the orders table", "en", "synthetic", "wc_db_migration"),
  task("please fix the flaky integration tests", "en", "synthetic", "wc_flaky_tests"),
  task("session timeout logs users out after idle", "en", "synthetic", "wc_session_idle"),
  task("warum wird das limit nicht zurueckgesetzt", "de", "synthetic"),
  task("Die Tests für den PDF-Export schlagen fehl", "de", "synthetic", "wc_export_tests"),
  task("mache bitte die Tests für den PDF-Export grün", "de", "synthetic", "wc_export_tests"),
  task("the idempotency key on checkout retries is stored too late", "en", "synthetic", "wc_checkout_retries"),
  task("monitor reports CI checks pass but the PR event is missing", "en", "synthetic", "wc_ci_monitor"),
  task("why is the current user joined twice in the task list", "en", "synthetic", "wc_task_list"),
  task("Gateway-Test für den Chunked Upload", "de", "synthetic", "wc_chunked_upload"),
  task("the usage limit reset should run per user, not globally", "en", "synthetic", "wc_usage_limit"),
  task("keep the retry limit separate from the restart budget", "en", "synthetic", "wc_usage_limit"),
  task("try a fresh usage limit per tenant", "en", "synthetic", "wc_usage_limit"),
  task(
    "ich habe mir das jetzt lange angesehen und verstehe immer noch nicht, warum der Chunked Upload beim Gateway-Test abbricht",
    "de",
    "synthetic",
    "wc_chunked_upload",
  ),
  // Draft-nudge review: the only tree that shares these words holds them in an unreviewed draft
  draftOnly("why does the zebrafrobnicator cache poison the quuxinator", "en", "wc_draft_only"),
  draftOnly("warum vergiftet der zebrafrobnicator cache den quuxinator", "de", "wc_draft_only"),
];

export const PROMPT_CORPUS: readonly CorpusPrompt[] = [
  ...REVIEW_CONTENT_FREE,
  ...PILOT_CONTENT_FREE,
  ...SYNTHETIC_CONTENT_FREE,
  ...REVIEW_TASKS,
  ...SYNTHETIC_TASKS,
];
