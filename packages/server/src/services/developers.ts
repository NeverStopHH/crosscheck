import { generateApiKey, hashApiKey } from "../auth/keys.ts";
import { EVENT_KINDS } from "../constants.ts";
import { developers } from "../db/schema.ts";
import { appendEvent } from "./events.ts";
import type { Db } from "../db/client.ts";
import type { Clock } from "../types.ts";

const DEVELOPER_ID_PREFIX = "dev_";

export interface DeveloperView {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

export interface CreateDeveloperInput {
  readonly name: string;
  readonly email: string;
}

export type CreateDeveloperResult =
  | {
      readonly outcome: "created";
      readonly developer: DeveloperView;
      readonly apiKey: string;
    }
  | { readonly outcome: "email_taken" };

export const createDeveloper = async (
  deps: { readonly db: Db; readonly now: Clock },
  input: CreateDeveloperInput,
): Promise<CreateDeveloperResult> => {
  const apiKey = generateApiKey();
  const id = `${DEVELOPER_ID_PREFIX}${crypto.randomUUID()}`;
  const inserted = await deps.db
    .insert(developers)
    .values({
      id,
      name: input.name,
      email: input.email,
      apiKeyHash: hashApiKey(apiKey),
      createdAt: deps.now(),
    })
    .onConflictDoNothing()
    .returning({ id: developers.id });
  if (inserted[0] === undefined) {
    return { outcome: "email_taken" };
  }
  await appendEvent(deps, EVENT_KINDS.DEVELOPER_CREATED, { developerId: id });

  return {
    outcome: "created",
    developer: { id, name: input.name, email: input.email },
    apiKey,
  };
};