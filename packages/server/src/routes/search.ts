/**
 * GET /api/search — the hub side of `search_related_work` (DESIGN.md §6).
 *
 * `repo` is a RELEVANCE filter, not a boundary (DESIGN.md §2.1): its value
 * comes from the caller's own checkout, the hub cannot re-derive it from the
 * api key, and any work context this endpoint omits is still readable by id
 * through the diagnosis route. Omitting `repo` searches the whole hub.
 *
 * `developer` and `since` are the WHO and WHEN of roadmap R1. Both are
 * RESOLVED here and applied inside the search service's tier queries, and
 * both are ECHOED back in `filters`: a renderer must be able to state which
 * filters ran without guessing, the same rule `vectorTierActive` follows.
 *
 * A developer term that does not resolve is a 400, never an empty result.
 * "No work contexts" in answer to a misspelt name reads as "Ken has done
 * nothing", and a model acts on that by redoing Ken's work — so the two miss
 * paths (`ambiguous_developer`, `unknown_developer`) carry sentences naming
 * the candidates or the closest known spellings instead.
 */
import { Hono } from "hono";
import { z } from "zod";

import { fail, ok } from "../http/envelope.ts";
import { formatIssues } from "../http/request.ts";
import { developerAuth } from "../middleware/auth.ts";
import {
  describeAmbiguousDeveloper,
  describeUnknownDeveloper,
  lookUpDeveloper,
  MAX_DEVELOPER_REF_CHARS,
} from "../services/developer-lookup.ts";
import {
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_QUERY_CHARS,
  searchWorkContexts,
} from "../services/search.ts";
import { sharedNameEmail } from "../services/developer-settings.ts";
import { parseSinceWindow } from "../services/time-window.ts";
import type { AppDeps, AppEnv } from "../types.ts";

/** Longest `since` term. `2026-08-01T09:00:00.000+02:00` is 29 characters. */
const MAX_SINCE_CHARS = 40;

/**
 * Oversized limits are capped in the search service, not rejected here — but
 * an oversized QUERY is rejected: unbounded token lists can fault the embedded
 * database (SEARCH_MAX_QUERY_CHARS in the service), and a client that sends
 * 34 KB of query deserves an answer naming the bound, not a truncated search.
 */
const SearchQuerySchema = z.object({
  query: z.string().max(SEARCH_MAX_QUERY_CHARS).default(""),
  repo: z.string().min(1).optional(),
  developer: z.string().min(1).max(MAX_DEVELOPER_REF_CHARS).optional(),
  since: z.string().min(1).max(MAX_SINCE_CHARS).optional(),
  limit: z.coerce.number().int().min(1).default(SEARCH_DEFAULT_LIMIT),
});

/** What ran, as the response reports it. Null means "that filter was off". */
interface AppliedFilters {
  readonly developer: {
    readonly name: string;
    /**
     * Sent only when the display name is shared — the one case where naming
     * the filter by name alone would tell the reader less than they knew
     * before they asked (services/developer-settings.ts `sharedNameEmail`).
     */
    readonly email: string | null;
    readonly isSelf: boolean;
  } | null;
  readonly since: string | null;
}

export const searchRoutes = (deps: AppDeps): Hono<AppEnv> => {
  const router = new Hono<AppEnv>();
  router.use("*", developerAuth(deps));

  router.get("/", async (c) => {
    const parsed = SearchQuerySchema.safeParse({
      query: c.req.query("query"),
      repo: c.req.query("repo"),
      developer: c.req.query("developer"),
      since: c.req.query("since"),
      limit: c.req.query("limit"),
    });
    if (!parsed.success) {
      return fail(c, 400, "validation_failed", formatIssues(parsed.error));
    }
    const {
      developer: developerTerm,
      since: sinceTerm,
      ...query
    } = parsed.data;

    let filters: AppliedFilters = { developer: null, since: null };
    let developerId: string | undefined;
    if (developerTerm !== undefined) {
      // A term that is only whitespace passes `min(1)`, trims to nothing in
      // the resolver, misses, and comes back through the unknown-name path —
      // whose echo trims it a second time, so the sentence opens with a
      // quoted nothing and the reader goes looking for a name they never
      // sent. It is a different mistake and it gets a different sentence.
      if (developerTerm.trim().length === 0) {
        return fail(
          c,
          400,
          "invalid_developer",
          "developer cannot be blank — name a teammate, give an address they " +
            "are known by, or omit the filter to search everyone's work.",
        );
      }
      const lookup = await lookUpDeveloper(deps.db, developerTerm);
      if (lookup.outcome === "ambiguous") {
        return fail(
          c,
          400,
          "ambiguous_developer",
          describeAmbiguousDeveloper(
            developerTerm,
            lookup.candidates,
            lookup.totalCount,
          ),
        );
      }
      if (lookup.outcome === "unknown") {
        return fail(
          c,
          400,
          "unknown_developer",
          describeUnknownDeveloper(developerTerm, lookup.suggestions),
        );
      }
      developerId = lookup.developer.id;
      filters = {
        ...filters,
        developer: {
          name: lookup.developer.name,
          // Both of these are things only the hub knows — whether this name
          // belongs to one person, and who is asking. A renderer would have
          // to guess at either.
          email: await sharedNameEmail(deps.db, lookup.developer.id),
          isSelf: lookup.developer.id === c.get("developer").id,
        },
      };
    }

    let since: Date | undefined;
    if (sinceTerm !== undefined) {
      // Same shape, same reason: `parseSinceWindow` trims, so a blank window
      // would be echoed back as an empty pair of quotes beside the forms.
      if (sinceTerm.trim().length === 0) {
        return fail(
          c,
          400,
          "invalid_since",
          "since cannot be blank — give a window like 14d or 72h, or an ISO " +
            "date like 2026-08-01, or omit it to search all of history.",
        );
      }
      const window = parseSinceWindow(sinceTerm, deps.now());
      if (!window.ok) {
        return fail(c, 400, "invalid_since", window.reason);
      }
      since = window.since;
      filters = { ...filters, since: window.since.toISOString() };
    }

    const response = await searchWorkContexts(deps, {
      ...query,
      ...(developerId === undefined ? {} : { developerId }),
      ...(since === undefined ? {} : { since }),
    });
    return ok(c, { ...response, filters });
  });

  return router;
};
