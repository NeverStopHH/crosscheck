/**
 * Connection-level failures must say what ACTUALLY happened and name the
 * matching remedy. The incident (2026-08-18, live trial onboarding): a remote
 * teammate's every CLI call printed "hub unreachable: <url>" while the real
 * cause was the 400 ms default timeout against a ~600 ms DERP-relay path —
 * the honest sentence ("timed out after 400 ms") would have named the fix in
 * the first minute instead of the second hour.
 *
 * Surface tests here talk to real local sockets (the cli.test.ts pattern);
 * the classifier's per-shape pins live beside them with INJECTED error
 * objects, so no test depends on real network timing beyond loopback.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { runDoctor } from "../src/cli/doctor.ts";
import { runLogin } from "../src/cli/login.ts";
import {
  classifyConnectionError,
  describeConnectionFailure,
  refineRefusedCause,
  shortConnectionMessage,
} from "@crosscheck/connector-core/http/connection-error.ts";
import { HTTP_TIMEOUT_MS } from "@crosscheck/connector-core/constants.ts";
import { makeHome, makeRepo } from "../../connector-core/test/helpers.ts";

/** The discard port refuses instantly — doctor-latency.test.ts's own pattern. */
const REFUSED_HUB_URL = "http://127.0.0.1:9";

/** Tight enough to keep the doctor surface test fast; the number must appear. */
const TIGHT_TIMEOUT_MS = 50;

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
  paths.length = 0;
});

/** Never answers: the probe dies of AbortSignal.timeout, the incident shape. */
const hangingHub = (): ReturnType<typeof Bun.serve> =>
  Bun.serve({
    port: 0,
    fetch: () => new Promise<Response>(() => undefined),
  });

/** An Error carrying the runtime's `code` property, as Bun's fetch throws. */
const codedError = (code: string, message = "boom"): Error =>
  Object.assign(new Error(message), { code });

describe("classifyConnectionError pins the injected shapes", () => {
  test("classifies every shape the research measured, plus node-style codes", () => {
    // Arrange: the left column of the table in src/http/connection-error.ts —
    // each object mirrors what Bun 1.3.13 actually threw under that failure,
    // plus the node-style spellings a future runtime might switch to.
    const cases: readonly (readonly [unknown, string])[] = [
      [new DOMException("The operation timed out.", "TimeoutError"), "timeout"],
      [new DOMException("The operation was aborted.", "AbortError"), "timeout"],
      [codedError("ConnectionRefused", "Unable to connect. Is the computer able to access the url?"), "refused"],
      [codedError("ECONNREFUSED"), "refused"],
      [codedError("ENOTFOUND", "getaddrinfo ENOTFOUND"), "dns"],
      [codedError("EAI_AGAIN"), "dns"],
      [Object.assign(new Error("getaddrinfo ENOTFOUND"), { name: "DNSException" }), "dns"],
      [codedError("ECONNRESET", "The socket connection was closed unexpectedly."), "reset"],
      [codedError("EPIPE"), "reset"],
      [codedError("Malformed_HTTP_Response", "Malformed_HTTP_Response fetching ..."), "protocol"],
      [codedError("DEPTH_ZERO_SELF_SIGNED_CERT", "self signed certificate"), "tls"],
      [new Error("SSL routines: wrong version number"), "tls"],
      [new Error("something else entirely"), "unknown"],
      ["not even an error", "unknown"],
      // Nullish must classify, not crash: classification runs inside
      // performRequest's catch but OUTSIDE its try, so a runtime that ever
      // throws null would otherwise turn a login failure into a stack trace
      // instead of a sentence.
      [null, "unknown"],
      [undefined, "unknown"],
    ];

    // Act + Assert
    for (const [error, expected] of cases) {
      expect(classifyConnectionError(error), JSON.stringify(expected)).toBe(
        expected as ReturnType<typeof classifyConnectionError>,
      );
    }
  });
});

describe("the live runtime still throws the researched shapes", () => {
  // These pin the RESEARCH, not the classifier: a Bun upgrade that changes
  // what fetch throws fails here, instead of silently sending every failure
  // down the "unknown" branch. All sockets are loopback and deterministic.
  const LIVE_PROBE_TIMEOUT_MS = 50;

  test("a hung server plus AbortSignal.timeout classifies as timeout", async () => {
    // Arrange
    const server = hangingHub();

    // Act
    let caught: unknown;
    try {
      await fetch(`http://127.0.0.1:${server.port}/`, {
        signal: AbortSignal.timeout(LIVE_PROBE_TIMEOUT_MS),
      });
    } catch (error) {
      caught = error;
    }
    server.stop(true);

    // Assert
    expect(classifyConnectionError(caught)).toBe("timeout");
  });

  test("the discard port classifies as refused", async () => {
    // Act
    let caught: unknown;
    try {
      await fetch(REFUSED_HUB_URL, { signal: AbortSignal.timeout(2_000) });
    } catch (error) {
      caught = error;
    }

    // Assert
    expect(classifyConnectionError(caught)).toBe("refused");
  });

  test("https against a plain-http port collapses to refused — the (!) row", async () => {
    // Arrange: a plain http listener; the client insists on TLS at it. This
    // is the one collapsed row a loopback socket CAN pin (the unresolvable-
    // name row would need real DNS) — and the collapse is the entire reason
    // the "refused" message hedges and login/doctor refine via node:dns.
    const plain = Bun.serve({ port: 0, fetch: () => new Response("ok") });

    // Act
    let caught: unknown;
    try {
      await fetch(`https://127.0.0.1:${plain.port}/`, {
        signal: AbortSignal.timeout(2_000),
      });
    } catch (error) {
      caught = error;
    }
    plain.stop(true);

    // Assert: Bun cannot tell this from refused — not a tls classification
    expect(classifyConnectionError(caught)).toBe("refused");
  });

  test("non-http bytes on the port classify as protocol", async () => {
    // Arrange: a raw TCP listener that answers with garbage
    const junk = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(socket) {
          socket.write("NOT HTTP AT ALL\r\n\r\n");
          socket.end();
        },
        data() {
          // The request bytes are irrelevant.
        },
      },
    });

    // Act
    let caught: unknown;
    try {
      await fetch(`http://127.0.0.1:${junk.port}/`, {
        signal: AbortSignal.timeout(2_000),
      });
    } catch (error) {
      caught = error;
    }
    junk.stop(true);

    // Assert
    expect(classifyConnectionError(caught)).toBe("protocol");
  });

  test("a connection terminated on open classifies as reset", async () => {
    // Arrange
    const reset = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(socket) {
          socket.terminate();
        },
        data() {
          // Never reached.
        },
      },
    });

    // Act
    let caught: unknown;
    try {
      await fetch(`http://127.0.0.1:${reset.port}/`, {
        signal: AbortSignal.timeout(2_000),
      });
    } catch (error) {
      caught = error;
    }
    reset.stop(true);

    // Assert
    expect(classifyConnectionError(caught)).toBe("reset");
  });
});

describe("shortConnectionMessage", () => {
  test("a timeout names the number of milliseconds that governed the call", () => {
    expect(shortConnectionMessage("timeout", undefined, HTTP_TIMEOUT_MS)).toBe(
      `timed out after ${HTTP_TIMEOUT_MS} ms`,
    );
  });

  test("unrefined refused stays hedged — bun cannot tell the three apart", () => {
    // The transport-level phrase reaches surfaces that never refine (sync
    // state, MCP tools), so claiming "refused" flatly would state more than
    // the runtime knows.
    const message = shortConnectionMessage("refused", undefined, HTTP_TIMEOUT_MS);
    expect(message).toContain("could not connect");
    expect(message).toContain("unresolvable name");
  });

  test("unknown passes the raw error message through", () => {
    expect(
      shortConnectionMessage("unknown", new Error("weird transport"), HTTP_TIMEOUT_MS),
    ).toBe("weird transport");
    expect(shortConnectionMessage("unknown", "not an error", HTTP_TIMEOUT_MS)).toBe(
      "request failed",
    );
  });
});

describe("refineRefusedCause", () => {
  const REFINE_DEADLINE_MS = 100;

  test("a name that does not resolve turns refused into dns", async () => {
    // Arrange: the lookup rejects, as node:dns does for NXDOMAIN
    const rejecting = () => Promise.reject(new Error("getaddrinfo ENOTFOUND"));

    // Act + Assert
    expect(
      await refineRefusedCause("refused", "http://hub.wrong-tailnet.ts.net:7777", rejecting),
    ).toBe("dns");
  });

  test("a name that resolves keeps refused — the hub story, not the dns one", async () => {
    // Arrange
    const resolving = () => Promise.resolve({ address: "127.0.0.1", family: 4 });

    // Act + Assert
    expect(
      await refineRefusedCause("refused", "http://127.0.0.1:7777", resolving),
    ).toBe("refused");
  });

  test("a hanging resolver is bounded and falls back to refused", async () => {
    // Arrange: a lookup that never settles — the resolver behind the dead VPN
    const hanging = () => new Promise<never>(() => undefined);

    // Act
    const startedMs = Date.now();
    const cause = await refineRefusedCause(
      "refused",
      "http://hub.example.com",
      hanging,
      REFINE_DEADLINE_MS,
    );
    const elapsedMs = Date.now() - startedMs;

    // Assert: the deadline answered, not the lookup
    expect(cause).toBe("refused");
    expect(elapsedMs).toBeLessThan(REFINE_DEADLINE_MS * 10);
  });

  test("every non-refused cause passes through without consulting the lookup", async () => {
    // Arrange
    let consulted = 0;
    const spying = () => {
      consulted += 1;
      return Promise.resolve(undefined);
    };

    // Act + Assert
    for (const cause of ["timeout", "dns", "reset", "protocol", "tls", "unknown"] as const) {
      expect(await refineRefusedCause(cause, "http://hub.example.com", spying)).toBe(cause);
    }
    expect(consulted).toBe(0);
  });
});

describe("describeConnectionFailure names cause, url and remedy", () => {
  const CONTEXT = { hubUrl: "http://hub.example.com:7777", timeoutMs: 400 };

  test("timeout names the ms, that login measures, and the env var", () => {
    const text = describeConnectionFailure("timeout", CONTEXT, "");
    expect(text).toContain("timed out after 400 ms");
    expect(text).toContain(CONTEXT.hubUrl);
    expect(text).toContain("crosscheck login");
    expect(text).toContain("measures");
    expect(text).toContain("CROSSCHECK_TIMEOUT_MS");
  });

  test("dns points at the name and the vpn/tailnet serving it", () => {
    const text = describeConnectionFailure("dns", CONTEXT, "");
    expect(text).toContain("resolve");
    expect(text).toContain(CONTEXT.hubUrl);
    expect(text).toContain("VPN/tailnet");
  });

  test("refused asks whether the hub is running and the port is right", () => {
    const text = describeConnectionFailure("refused", CONTEXT, "");
    expect(text).toContain("connection refused");
    expect(text).toContain("is the hub running");
    expect(text).toContain("port");
  });

  test("protocol and tls both point at the port or a proxy", () => {
    expect(describeConnectionFailure("protocol", CONTEXT, "")).toContain("proxy");
    expect(describeConnectionFailure("tls", CONTEXT, "")).toContain("certificate");
  });

  test("unknown keeps the raw message so nothing is ever hidden", () => {
    const text = describeConnectionFailure("unknown", CONTEXT, "weird transport");
    expect(text).toContain("hub unreachable");
    expect(text).toContain("weird transport");
  });
});

describe("login names the real connection failure", () => {
  test("a refused connection says refused and asks about the hub, not 'unreachable'", async () => {
    // Arrange
    const home = await makeHome("honest-login-refused");
    paths.push(home);

    // Act
    const result = await runLogin(
      [REFUSED_HUB_URL],
      { CROSSCHECK_HOME: home, CROSSCHECK_API_KEY: "test-key" },
      async () => null,
      () => Promise.resolve(null),
    );

    // Assert: the cause and the remedy, in one sentence naming the url
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toContain("connection refused");
    expect(result.stdout).toContain("is the hub running");
    expect(result.stdout).toContain(REFUSED_HUB_URL);
    expect(result.stdout).not.toContain("hub unreachable:");
  });
});

describe("doctor names the real connection failure", () => {
  test("a timed-out probe says how many ms and names both timeout remedies", async () => {
    // Arrange: the hub answers, just slower than the tight effective timeout —
    // THE incident state. The latency measurement is injected null so the
    // hub-reachable line alone has to carry the story.
    const repo = await makeRepo("honest-doctor-timeout", {
      remote: "git@github.com:acme/api.git",
    });
    const home = await makeHome("honest-doctor-timeout");
    paths.push(repo, home);
    const server = hangingHub();

    // Act
    const result = await runDoctor(
      {
        CROSSCHECK_HOME: home,
        HOME: home,
        CROSSCHECK_HUB_URL: `http://127.0.0.1:${server.port}`,
        CROSSCHECK_API_KEY: "test-key",
        CROSSCHECK_TIMEOUT_MS: String(TIGHT_TIMEOUT_MS),
      },
      repo,
      () => Promise.resolve(null),
    );
    server.stop(true);

    // Assert: what happened (a timeout, with the number) and what moves it
    expect(result.stdout).toContain("FAIL  hub reachable");
    expect(result.stdout).toContain(`timed out after ${TIGHT_TIMEOUT_MS} ms`);
    expect(result.stdout).toContain("crosscheck login");
    expect(result.stdout).toContain("CROSSCHECK_TIMEOUT_MS");
  });

  test("a refused connection says refused and asks about the hub and port", async () => {
    // Arrange
    const repo = await makeRepo("honest-doctor-refused", {
      remote: "git@github.com:acme/api.git",
    });
    const home = await makeHome("honest-doctor-refused");
    paths.push(repo, home);

    // Act
    const result = await runDoctor(
      {
        CROSSCHECK_HOME: home,
        HOME: home,
        CROSSCHECK_HUB_URL: REFUSED_HUB_URL,
        CROSSCHECK_API_KEY: "test-key",
      },
      repo,
      () => Promise.resolve(null),
    );

    // Assert
    expect(result.stdout).toContain("FAIL  hub reachable");
    expect(result.stdout).toContain("connection refused");
    expect(result.stdout).toContain("is the hub running");
  });
});
