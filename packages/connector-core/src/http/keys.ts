/**
 * `POST /api/keys/rotate` — the owner replaces their own api key.
 *
 * STRICT on the one field that matters: a key is 64 hex characters (the
 * hub's generateApiKey), and anything else is refused here rather than
 * written into the config, where it would lock this machine out with a value
 * nobody can use.
 */
import { z } from "zod";

import { hubRequest } from "./client.ts";
import type { HubContext, HubResult } from "./client.ts";

const API_KEY_PATTERN = /^[0-9a-f]{64}$/;

const RotatedKeySchema = z.object({ apiKey: z.string().regex(API_KEY_PATTERN) });

export const rotateOwnKey = (ctx: HubContext): Promise<HubResult<{ readonly apiKey: string }>> =>
  hubRequest(ctx, { method: "POST", path: "/api/keys/rotate", body: {}, schema: RotatedKeySchema });
