import { join } from "node:path";
import { z } from "zod";

import { PROTOCOL_VERSION } from "@crosscheck/schema";
import { REPO_CONFIG_FILE } from "../constants.ts";
import { readJsonOrNull } from "./paths.ts";

/**
 * Committed into the team repo (DESIGN.md §2.1: the repo decides where a
 * session reports). It carries the hub URL only — never the api key.
 */
export const RepoConfigSchema = z.looseObject({
  hubUrl: z.string().min(1),
  protocol: z.string().min(1).optional(),
});

export type RepoConfig = z.infer<typeof RepoConfigSchema>;

export const repoConfigPath = (repoRoot: string): string =>
  join(repoRoot, REPO_CONFIG_FILE);

export const readRepoConfig = async (
  repoRoot: string,
): Promise<RepoConfig | null> => {
  const parsed = RepoConfigSchema.safeParse(
    await readJsonOrNull(repoConfigPath(repoRoot)),
  );
  return parsed.success ? parsed.data : null;
};

export const renderRepoConfig = (hubUrl: string): string =>
  `${JSON.stringify({ hubUrl, protocol: PROTOCOL_VERSION }, null, 2)}\n`;
