import type { Context } from "hono";
import type { z } from "zod";

/** Returns null for an empty or malformed JSON body instead of throwing. */
export const readJsonBody = async (c: Context): Promise<unknown> => {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
};

export const formatIssues = (error: z.ZodError): string =>
  error.issues
    .map(
      (issue) =>
        `${issue.path.map(String).join(".") || "<root>"}: ${issue.message}`,
    )
    .join("; ");