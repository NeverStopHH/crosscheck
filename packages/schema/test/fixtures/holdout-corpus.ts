/**
 * THE FIRST HOLD-OUT, NOW TRAINING DATA (hold-out review, H2): 244 prompts
 * and 23 trees the round before never saw, written by the reviewer as
 * realistic teammate notes, the generic verbs real notes use (run, stop,
 * wait, show, diff, commit, push, status, limit, reset, session, retry)
 * where a developer would write them. Labels as the reviewer proposed them:
 * interrupts, answer-shaping, option-picking and commands to the agent with
 * no object of their own are content-free; "CI?" and a command with an
 * object are tasks; "continue with the reset" is content-free, the owner's
 * own typical prompt about the session.
 *
 * SYNTHETIC TEXT ONLY. Rows from here on are measured, not tuned: the next
 * review evaluates on a FRESH hold-out (prompt-corpus-gate.test.ts), and
 * every row it fails becomes a row in the corpus.
 */
import type { CorpusPrompt, CorpusTree, PromptLanguage } from "./prompt-corpus.ts";

const free = (prompt: string, language: PromptLanguage): CorpusPrompt => ({
  prompt,
  label: "content_free",
  language,
  source: "review",
});

const task = (prompt: string, language: PromptLanguage, tree?: string): CorpusPrompt => ({
  prompt,
  label: "task",
  language,
  source: "review",
  ...(tree === undefined ? {} : { tree }),
});

export const HOLDOUT_TREES: readonly CorpusTree[] = [
  { id: "wc_jwt", title: "JWT refresh breaks parallel requests", description: "Token rotation", claims: ["The refresh endpoint rotates the JWT before the old one expires, so two parallel requests race on the refresh token."] },
  { id: "wc_ci", title: "CI pipeline red on main", description: "Lint before build", claims: ["CI is red because the lint step runs before the build and cannot find the generated types.", "Check the CI status again after the cache key change."] },
  { id: "wc_migration", title: "Prisma migration hangs on deploy", description: "Lock wait", claims: ["The migration waits on a lock held by the import worker; stop the worker before you run the migration."] },
  { id: "wc_oom", title: "Import worker OOM", description: "Memory per batch", claims: ["The import worker runs out of memory (OOM) when a batch holds more than 500 matches."] },
  { id: "wc_prepush", title: "Pre-push hook blocks commits", description: "Lint in the hook", claims: ["The pre-push hook rejects the commit when lint fails; run lint before you commit and push."] },
  { id: "wc_diff", title: "Diff view hides renamed files", description: "git diff -M", claims: ["The diff view does not show renamed files, because git diff runs without -M."] },
  { id: "wc_review", title: "Code review checklist", description: "Before merge", claims: ["Every PR needs a code review from Ken before the merge."] },
  { id: "wc_ratelimit", title: "StatsBomb API rate limit", description: "429 handling", claims: ["The usage limit of the StatsBomb API resets every hour; retry only after the reset."] },
  { id: "wc_session", title: "Login session expires too early", description: "Refresh cookie path", claims: ["The login session expires after 15 minutes because the refresh cookie path is wrong."] },
  { id: "wc_status", title: "Status endpoint shows stale data", description: "Cached update", claims: ["The status endpoint caches the last update for 10 minutes, so the status looks wrong right after a deploy."] },
  { id: "wc_upload_de", title: "Upload bricht bei großen Videos ab", description: "Worker wartet", claims: ["Der Upload bricht ab, wenn das Video größer als 2 GB ist; der Worker wartet dann ewig."] },
  { id: "wc_e2e", title: "Flaky e2e tests", description: "Test server start", claims: ["The e2e tests fail again and again because the test server does not wait for the database."] },
  { id: "wc_build", title: "Docker build does not start", description: "Cache full", claims: ["The Docker build does not start when the build cache is full; prune it and start the build again."] },
  { id: "wc_merge", title: "Merge conflicts in bun.lock", description: "Lockfile", claims: ["On merge conflicts in bun.lock, delete it and run bun install again."] },
  { id: "wc_revert", title: "Revert of the cube seal commit", description: "Disk fix", claims: ["Reverting the cube seal commit undoes the disk fix, so do not revert it."] },
  { id: "wc_monitor", title: "Deploy monitor loop", description: "Polling", claims: ["The deploy monitor checks the status every 5 minutes and stops when the deploy is done."] },
  { id: "wc_context", title: "Agent context window fills up", description: "Compaction", claims: ["The agent context fills up after 40 turns; compact the context before it runs out."] },
  { id: "wc_option", title: "Cube cache: option 2", description: "Per-match cache", claims: ["Option 2 caches the cube per match; option 1 was dropped because of the disk use."] },
  { id: "wc_weiter_button", title: "Weiter-Button im Wizard reagiert nicht", description: "Onboarding-Formular", claims: ["Der Weiter-Button im Onboarding-Wizard reagiert nicht, weil das Formular nicht validiert."] },
  { id: "wc_retry_button", title: "Retry button on failed uploads is broken", description: "Upload UI", claims: ["The retry button on a failed upload is broken: it re-sends the old chunk list."] },
  { id: "wc_worker_wait", title: "Worker hangs on shutdown", description: "SIGTERM", claims: ["On SIGTERM the worker does not stop; it waits for the whole batch and holds the lock."] },
  { id: "wc_tests_run", title: "Running the tests locally", description: "Test setup", claims: ["Run the tests with --runInBand, otherwise the fixtures collide."] },
  { id: "wc_think", title: "Model explains the plan wrong", description: "Prompt quality", claims: ["The model explains the plan in more detail than needed and gets the order wrong; ask it to think again with a shorter answer."] },
];

export const HOLDOUT_CONTENT_FREE: readonly CorpusPrompt[] = [
  // colloquial, Swiss, emoji, punctuation, assent, refusal
  free("passt scho", "de"), free("jo mach", "de"), free("weida", "de"), free("jo, weida", "de"),
  free("passt, mach weida", "de"), free("👍", "en"), free("👍👍", "en"), free("🚀", "en"), free("✅ weiter", "de"),
  free("...", "en"), free("?", "en"), free("??", "en"), free("!", "en"), free("ja", "de"), free("nein", "de"),
  free("stop", "en"), free("warte", "de"), free("kurz", "de"), free("warte kurz", "de"), free("moment", "de"),
  free("hmm", "en"), free("ok", "en"), free("okidoki", "de"), free("jep", "de"), free("yup", "en"), free("yes", "en"),
  free("no", "en"), free("nope", "en"), free("k", "en"), free("thx", "en"), free("danke dir", "de"), free("merci", "de"),
  free("vielen dank", "de"), free("top, danke", "de"), free("sehr gut", "de"), free("wunderbar, weiter so", "de"),
  free("genau so", "de"), free("richtig", "de"), free("korrekt", "de"), free("stimmt", "de"), free("verstanden", "de"),
  free("got it", "en"), free("makes sense", "en"), free("fair enough", "en"), free("agreed", "en"), free("exactly", "en"),
  free("right", "en"), free("hold on", "en"), free("wait, stop", "en"), free("hold on, wait", "en"),
  free("never mind", "en"), free("egal, weiter", "de"), free("mach einfach", "de"), free("mach du", "de"),
  free("you decide", "en"), free("your call", "en"), free("whatever you think is best", "en"), free("go", "en"),
  free("los", "de"), free("los gehts", "de"), free("weiter gehts", "de"), free("auf gehts", "de"), free("next", "en"),
  free("und jetzt?", "de"), free("and now?", "en"), free("what next?", "en"), free("was nun?", "de"),
  free("status?", "en"), free("any update?", "en"), free("bist du fertig?", "de"), free("are you done?", "en"),
  free("fertig?", "de"), free("done?", "en"),
  // typos of steering words
  free("contiune", "en"), free("pls contnue", "en"), free("weiterr", "de"), free("mahce weiter", "de"),
  free("mach weiter bitet", "de"), free("conitnue pls", "en"), free("keep goin", "en"),
  // limit-reset paraphrases no report list holds
  free("mach weiter, usage limit ist wieder da", "de"), free("macxhe weiter, usage limit ist zurukgsetz", "de"),
  free("limit vorbei, weiter", "de"), free("rate limit ist vorbei, mach weiter", "de"),
  free("session limit is over, continue", "en"), free("usage limit gone, continue", "en"),
  free("weekly usage limit expired, keep going", "en"), free("Kontingent wieder voll, weiter", "de"),
  free("Limit wieder ok, weiter bitte", "de"), free("the 5h limit is up again, carry on", "en"),
  free("token limit refreshed, continue", "en"), free("ok weiter, das Limit hat sich erneuert", "de"),
  free("continue with the reset", "en"),
  // choosing among the agent's own options, shaping its answer
  free("Option 2 bitte", "de"), free("nimm Variante B", "de"), free("take option A", "en"), free("the second one", "en"),
  free("die erste", "de"), free("beides", "de"), free("both", "en"), free("all of them", "en"), free("alle", "de"),
  free("mach alles", "de"), free("do all of it", "en"), free("sure, go for it", "en"), free("klingt vernünftig", "de"),
  free("sounds reasonable", "en"), free("ok, and then?", "en"), free("same again", "en"), free("nochmal von vorne", "de"),
  free("start over", "en"), free("try harder", "en"), free("denk nochmal nach", "de"), free("think again", "en"),
  free("explain", "en"), free("erklär", "de"), free("erklär nochmal", "de"), free("kürzer bitte", "de"),
  free("shorter please", "en"), free("auf deutsch bitte", "de"), free("in english please", "en"),
  free("mehr details", "de"), free("more detail", "en"), free("explain it again, in more detail", "en"),
  free("think again, shorter", "en"),
];

/** Commands to the agent with no object of their own — content-free, as the reviewer proposed. */
export const HOLDOUT_OPERATIONS: readonly CorpusPrompt[] = [
  free("commit das", "de"), free("commit", "en"), free("push", "en"), free("commit und push", "de"),
  free("commit and push", "en"), free("zeig mir den diff", "de"), free("show me the diff", "en"),
  free("run the tests", "en"), free("lass die tests laufen", "de"), free("mach nen PR", "de"), free("open a PR", "en"),
  free("merge it", "en"), free("rebase on main", "en"), free("git status", "en"), free("undo that", "en"),
  free("revert it", "en"), free("revert das", "de"), free("lösch das", "de"), free("delete it", "en"),
  free("speicher das", "de"), free("save it", "en"), free("schreib das auf", "de"), free("write it down", "en"),
  free("/compact", "en"), free("/code-review", "en"), free("/walkthrough", "en"), free("/loop 5m /babysit-prs", "en"),
  free("check the logs", "en"), free("schau in die logs", "de"), free("deploy it", "en"), free("build it", "en"),
  free("lint", "en"), free("fix lint", "en"), free("run the tests again", "en"), free("show the status", "en"),
  free("stop the build", "en"), free("commit, push and open the PR", "en"), free("run lint and commit", "en"),
];

/**
 * Short real tasks. A row with a tree shares two words with it and must be
 * hinted. "CI rot" names the CI tree but shares only "CI" with it ("rot" is
 * German for red), so it stays a task without a tree to reach.
 */
export const HOLDOUT_TASKS: readonly CorpusPrompt[] = [
  task("JWT refresh kaputt", "mixed", "wc_jwt"), task("CI rot", "de"), task("migration hängt", "de"),
  task("OOM im worker", "mixed", "wc_oom"), task("CI ist rot wegen lint", "de"), task("CI red on main", "en", "wc_ci"),
  task("lint step fails before build", "en", "wc_ci"), task("worker OOM bei großen batches", "mixed", "wc_oom"),
  task("import worker runs out of memory", "en", "wc_oom"), task("pre-push hook blockiert commit", "mixed", "wc_prepush"),
  task("diff zeigt umbenannte Dateien nicht", "de"), task("renamed files missing in diff view", "en", "wc_diff"),
  task("who reviews my PR before merge?", "en", "wc_review"), task("StatsBomb rate limit", "en", "wc_ratelimit"),
  task("StatsBomb API usage limit reset", "en", "wc_ratelimit"), task("retry after StatsBomb reset", "en", "wc_ratelimit"),
  // Round 3, C1: session, expires and minutes are all machinery — a task, but no tree's topic
  task("session expires after 15 minutes", "en"), task("login session läuft zu früh ab", "mixed", "wc_session"),
  task("status endpoint stale after deploy", "en", "wc_status"), task("Upload bricht bei großen Videos ab", "de", "wc_upload_de"),
  task("e2e tests flaky", "en", "wc_e2e"), task("e2e tests schlagen immer wieder fehl", "mixed", "wc_e2e"),
  task("Docker build startet nicht", "mixed", "wc_build"), task("bun.lock merge conflict", "en", "wc_merge"),
  task("should I revert the cube seal commit?", "en", "wc_revert"), task("deploy monitor stops too early", "en", "wc_monitor"),
  task("context window fills up after 40 turns", "en", "wc_context"), task("continue button does nothing", "en"),
  task("Weiter-Button reagiert nicht", "de", "wc_weiter_button"), task("retry button broken", "en", "wc_retry_button"),
  task("keep the retry button visible", "en", "wc_retry_button"),
  task("try the retry button again after the reset", "en", "wc_retry_button"),
  task("continue the prisma migration", "en", "wc_migration"), task("resume the upload after the reset", "en"),
  task("weiter mit dem Passwort-Reset", "de"), task("next step: password reset flow", "en"),
  task("nochmal den OOM fix testen", "mixed"), task("JWT läuft ab bevor refresh", "mixed", "wc_jwt"),
  task("refresh token race", "en", "wc_jwt"), task("parallel requests break the refresh", "en", "wc_jwt"),
  task("warum hängt die migration", "de"), task("migration waits on lock", "en", "wc_migration"),
  task("import worker holds the lock", "en", "wc_worker_wait"), task("lint fails on generated types", "en", "wc_ci"),
  task("cache key change broke CI", "en", "wc_ci"), task("PR braucht review von Ken", "mixed", "wc_review"),
  task("API rate limit 429", "en", "wc_ratelimit"), task("429 von StatsBomb", "mixed"),
  task("refresh cookie path wrong", "en", "wc_session"), task("status page wrong after deploy", "en", "wc_status"),
  task("Video größer als 2 GB", "de", "wc_upload_de"), task("test server waits for database", "en", "wc_e2e"),
  task("docker cache full", "en", "wc_build"), task("bun install again after merge conflicts", "en", "wc_merge"),
  task("cube seal disk fix", "en", "wc_revert"), task("deploy monitor every 5 minutes", "en", "wc_monitor"),
  task("agent context compact", "en", "wc_context"),
  task("Onboarding-Wizard Formular validiert nicht", "de", "wc_weiter_button"),
  task("upload retry button", "en", "wc_retry_button"), task("Stop the worker before migration?", "en", "wc_migration"),
  task("Wait for DB in e2e", "en", "wc_e2e"), task("flaky tests again", "en", "wc_e2e"), task("CI?", "en"),
  task("DB down", "en"), task("UI kaputt", "mixed"), task("S3 403", "en"), task("k8s pod crash", "en"),
  task("PR #74 CI", "en"), task("go build fails", "en"), task("npm ci kaputt", "mixed"),
  // Round 3, C1: "hoch" is the one topical word, and the rate-limit tree does not say it
  task("Retry-Limit nochmal hoch", "de"), task("usage limit für StatsBomb erhöhen", "mixed", "wc_ratelimit"),
  task("go on with the JWT refresh fix", "en", "wc_jwt"), task("mach weiter mit dem JWT refresh", "mixed", "wc_jwt"),
  task("weiter mit OOM im Worker", "de", "wc_oom"), task("continue the StatsBomb rate limit work", "en", "wc_ratelimit"),
  task("worker hängt beim SIGTERM", "mixed", "wc_worker_wait"), task("Worker stoppt nicht bei SIGTERM", "mixed", "wc_worker_wait"),
  task("the limit was reset but StatsBomb still returns 429, continue debugging", "en", "wc_ratelimit"),
  task("session context lost after restart, keep going on that", "en"),
  task("try restoring the session after the cookie fix", "en", "wc_session"),
];
