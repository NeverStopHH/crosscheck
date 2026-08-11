/**
 * CLI surface of the privacy controls (DESIGN.md §2.1): `crosscheck presence
 * off|on`, `crosscheck mute <developer>` / `unmute <developer>` / `mute
 * list`, plus the status/doctor lines that keep support conversations from
 * chasing ghosts. Enforcement itself is hub-side (server tests pin it);
 * these tests pin the commands, their scope statements, and what they send.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { runCli } from "../src/index.ts";
import { EXIT_FAIL, EXIT_OK, EXIT_USAGE } from "../src/constants.ts";
import { makeHome, makeRepo } from "./helpers.ts";

interface SeenRequest {
  readonly method: string;
  readonly pathname: string;
  readonly body: unknown;
}

interface FakeHub {
  readonly url: string;
  readonly requests: SeenRequest[];
  readonly stop: () => void;
}

interface FakeHubOptions {
  readonly presenceOptOut?: boolean;
  readonly mutes?: readonly { id: string; name: string }[];
  readonly muteStatus?: number;
  readonly settingsStatus?: number;
}

const startHub = (options: FakeHubOptions = {}): FakeHub => {
  const requests: SeenRequest[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const { pathname } = new URL(request.url);
      const body =
        request.method === "GET" || request.method === "DELETE"
          ? undefined
          : await request.json().catch(() => undefined);
      requests.push({ method: request.method, pathname, body });
      if (pathname === "/api/settings" && request.method === "GET") {
        if (options.settingsStatus !== undefined) {
          return new Response("not found", { status: options.settingsStatus });
        }
        return Response.json({
          ok: true,
          data: {
            presenceOptOut: options.presenceOptOut ?? false,
            mutes: options.mutes ?? [],
          },
        });
      }
      if (pathname === "/api/settings/presence") {
        const optOut =
          typeof body === "object" && body !== null
            ? (body as Record<string, unknown>)["optOut"]
            : undefined;
        return Response.json({ ok: true, data: { presenceOptOut: optOut } });
      }
      if (pathname === "/api/settings/mutes" && request.method === "POST") {
        if (options.muteStatus !== undefined) {
          return Response.json(
            {
              ok: false,
              error: {
                code: "not_found",
                message: "no developer matches that reference",
              },
            },
            { status: options.muteStatus },
          );
        }
        return Response.json({
          ok: true,
          data: {
            muted: { id: "dev_robin", name: "Robin" },
            alreadyMuted: false,
          },
        });
      }
      if (
        pathname.startsWith("/api/settings/mutes/") &&
        request.method === "DELETE"
      ) {
        return Response.json({
          ok: true,
          data: {
            unmuted: { id: "dev_robin", name: "Robin" },
            wasMuted: true,
          },
        });
      }
      if (pathname === "/api/presence") {
        return Response.json({ ok: true, data: { sessions: [] } });
      }
      if (pathname === "/api/absences") {
        return Response.json({ ok: true, data: { absences: [] } });
      }
      return Response.json({ ok: true, data: {} });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => {
      server.stop(true);
    },
  };
};

const paths: string[] = [];
const stops: (() => void)[] = [];

afterEach(async () => {
  for (const stop of stops) {
    stop();
  }
  stops.length = 0;
  await Promise.all(
    paths.map((path) => rm(path, { recursive: true, force: true })),
  );
  paths.length = 0;
});

const fixture = async (
  label: string,
  options: FakeHubOptions = {},
): Promise<{
  readonly repo: string;
  readonly env: Record<string, string>;
  readonly hub: FakeHub;
}> => {
  const hub = startHub(options);
  stops.push(hub.stop);
  const repo = await makeRepo(label, { remote: "git@github.com:acme/api.git" });
  const home = await makeHome(label);
  paths.push(repo, home);
  return {
    repo,
    hub,
    env: {
      CROSSCHECK_HOME: home,
      HOME: home,
      CROSSCHECK_HUB_URL: hub.url,
      CROSSCHECK_API_KEY: "test-key",
    },
  };
};

describe("crosscheck presence", () => {
  test("`presence off` opts out and states the exact scope", async () => {
    // Arrange
    const { repo, env, hub } = await fixture("presence-off");

    // Act
    const result = await runCli(["presence", "off"], env, repo);

    // Assert: the hub got the write
    const put = hub.requests.find(
      (entry) => entry.pathname === "/api/settings/presence",
    );
    expect(put?.method).toBe("PUT");
    expect(put?.body).toEqual({ optOut: true });
    // Assert: state + the two scope statements (task items 1 + CLI output)
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stdout).toContain("presence: hidden from teammates");
    expect(result.stdout).toContain("statusline");
    expect(result.stdout).toContain("absence");
    expect(result.stdout).toContain("session start/end events");
    expect(result.stdout).toContain("stay visible and attributed");
  });

  test("`presence on` opts back in", async () => {
    // Arrange
    const { repo, env, hub } = await fixture("presence-on");

    // Act
    const result = await runCli(["presence", "on"], env, repo);

    // Assert
    const put = hub.requests.find(
      (entry) => entry.pathname === "/api/settings/presence",
    );
    expect(put?.body).toEqual({ optOut: false });
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stdout).toContain("presence: visible to teammates");
  });

  test("bare `presence` reports the current hub-side state", async () => {
    // Arrange
    const { repo, env } = await fixture("presence-show", {
      presenceOptOut: true,
    });

    // Act
    const result = await runCli(["presence"], env, repo);

    // Assert
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stdout).toContain("presence: hidden from teammates");
  });

  test("an unknown subcommand prints usage", async () => {
    // Arrange
    const { repo, env } = await fixture("presence-usage");

    // Act
    const result = await runCli(["presence", "sideways"], env, repo);

    // Assert
    expect(result.exitCode).toBe(EXIT_USAGE);
    expect(result.stdout).toContain("presence off");
  });
});

describe("crosscheck mute / unmute", () => {
  test("`mute <developer>` sends the ref and states suppressed vs pullable surfaces", async () => {
    // Arrange
    const { repo, env, hub } = await fixture("mute");

    // Act
    const result = await runCli(["mute", "Robin"], env, repo);

    // Assert
    const post = hub.requests.find(
      (entry) =>
        entry.pathname === "/api/settings/mutes" && entry.method === "POST",
    );
    expect(post?.body).toEqual({ developer: "Robin" });
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stdout).toContain("muted Robin");
    expect(result.stdout).toContain("hints");
    expect(result.stdout).toContain("briefing");
    expect(result.stdout).toContain("get_diagnosis");
  });

  test("`unmute <developer>` deletes the mute", async () => {
    // Arrange
    const { repo, env, hub } = await fixture("unmute");

    // Act
    const result = await runCli(["unmute", "Robin"], env, repo);

    // Assert
    const del = hub.requests.find((entry) => entry.method === "DELETE");
    expect(del?.pathname).toBe("/api/settings/mutes/Robin");
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stdout).toContain("unmuted Robin");
  });

  test("`mute list` names the muted developers", async () => {
    // Arrange
    const { repo, env } = await fixture("mute-list", {
      mutes: [
        { id: "dev_robin", name: "Robin" },
        { id: "dev_sam", name: "Sam" },
      ],
    });

    // Act
    const result = await runCli(["mute", "list"], env, repo);

    // Assert
    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stdout).toContain("Robin");
    expect(result.stdout).toContain("Sam");
  });

  test("an unknown developer surfaces the hub's message and fails", async () => {
    // Arrange
    const { repo, env } = await fixture("mute-404", { muteStatus: 404 });

    // Act
    const result = await runCli(["mute", "Nobody"], env, repo);

    // Assert
    expect(result.exitCode).toBe(EXIT_FAIL);
    expect(result.stdout).toContain("no developer matches");
  });

  test("`unmute` without a developer prints usage", async () => {
    // Arrange
    const { repo, env } = await fixture("unmute-usage");

    // Act
    const result = await runCli(["unmute"], env, repo);

    // Assert
    expect(result.exitCode).toBe(EXIT_USAGE);
  });
});

describe("status and doctor show the privacy state", () => {
  test("status prints the presence state and mute list", async () => {
    // Arrange
    const { repo, env } = await fixture("status-privacy", {
      presenceOptOut: true,
      mutes: [{ id: "dev_robin", name: "Robin" }],
    });

    // Act
    const result = await runCli(["status"], env, repo);

    // Assert
    expect(result.stdout).toContain("presence: hidden from teammates");
    expect(result.stdout).toContain("muted: Robin");
  });

  test("doctor reports opt-out and mute counts", async () => {
    // Arrange
    const { repo, env } = await fixture("doctor-privacy", {
      presenceOptOut: true,
      mutes: [
        { id: "dev_robin", name: "Robin" },
        { id: "dev_sam", name: "Sam" },
      ],
    });

    // Act
    const result = await runCli(["doctor"], env, repo);

    // Assert: counts, never names — status carries the lines
    expect(result.stdout).toContain("privacy settings");
    expect(result.stdout).toContain("presence hidden (opt-out), 2 muted");
    expect(result.stdout).not.toContain("Robin");
  });

  test("doctor says 'not measured' against a hub without the endpoint", async () => {
    // Arrange
    const { repo, env } = await fixture("doctor-older-hub", {
      settingsStatus: 404,
    });

    // Act
    const result = await runCli(["doctor"], env, repo);

    // Assert
    expect(result.stdout).toContain("PASS  privacy settings  not measured");
  });
});
