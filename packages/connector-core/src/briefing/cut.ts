/**
 * The one cut every bounded untrusted string takes — moved to
 * @crosscheck/schema (untrusted-text.ts) with the rest of the untrusted-text
 * primitives (review 1006b, M4), its reasoning and its VERIFY beside it.
 * Re-exported here for the callers that import it from this path.
 */
export { cutWellFormed } from "@crosscheck/schema";
