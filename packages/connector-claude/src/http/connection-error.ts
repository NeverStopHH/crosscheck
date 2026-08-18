/**
 * What ACTUALLY happened when a hub call failed at the connection level, and
 * the remedy that matches. "hub unreachable: <url>" hid a plain timeout for an
 * hour of a real onboarding (2026-08-18, hub reached over a ~200-600 ms
 * Tailscale DERP relay): the honest sentence — "timed out after 400 ms", plus
 * the knob that moves it — was one classification away the whole time.
 *
 * THE SHAPES ARE EMPIRICAL, measured on Bun 1.3.13 and pinned against the
 * live runtime by test/connection-error.test.ts (an upgrade that changes them
 * fails a pin instead of silently degrading every message to "unknown"):
 *
 *   AbortSignal.timeout fired        DOMException, name "TimeoutError"
 *   connection refused               Error, code "ConnectionRefused"
 *   unresolvable hostname            Error, code "ConnectionRefused"  (!)
 *   https against a plain-http port  Error, code "ConnectionRefused"  (!)
 *   non-http bytes on the port       Error, code "Malformed_HTTP_Response"
 *   connection reset mid-request     Error, code "ECONNRESET"
 *
 * The (!) rows are the catch: Bun collapses refused, DNS failure and a wrong
 * TLS port into ONE code, so "refused" as classified here really means "could
 * not connect". Where a human is watching (login, doctor) it is refined by one
 * bounded node:dns lookup — a name that does not resolve is a DNS story with a
 * VPN remedy, a name that resolves against a refusing port is a hub story.
 * Hooks never refine: no extra I/O on a fail-open path. Node-style codes
 * (ECONNREFUSED, ENOTFOUND, EAI_AGAIN, name "DNSException") are matched too,
 * so a runtime that switches to them reclassifies instead of degrading.
 */
import { lookup } from "node:dns/promises";

import { DNS_REFINE_TIMEOUT_MS } from "../constants.ts";

export type ConnectionCause =
  | "timeout"
  | "dns"
  | "refused"
  | "reset"
  | "protocol"
  | "tls"
  | "unknown";

const stringProp = (error: unknown, key: string): string => {
  const value = (error as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
};

/** TLS/certificate failures have no single code; the vocabulary does recur. */
const TLS_TEXT_PATTERN = /\b(tls|ssl|cert|certificate|handshake)/i;

export const classifyConnectionError = (error: unknown): ConnectionCause => {
  const name = stringProp(error, "name");
  if (name === "TimeoutError" || name === "AbortError") {
    return "timeout";
  }
  const code = stringProp(error, "code");
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || name === "DNSException") {
    return "dns";
  }
  if (code === "ConnectionRefused" || code === "ECONNREFUSED") {
    return "refused";
  }
  if (code === "ECONNRESET" || code === "EPIPE") {
    return "reset";
  }
  if (code === "Malformed_HTTP_Response") {
    return "protocol";
  }
  const message = error instanceof Error ? error.message : "";
  if (TLS_TEXT_PATTERN.test(code) || TLS_TEXT_PATTERN.test(message)) {
    return "tls";
  }
  return "unknown";
};

/**
 * The short factual phrase the transport reports (http/client.ts) — it flows
 * into sync-state, the statusline's story and the MCP tools' error text, so
 * it states the fact without a CLI remedy. "refused" stays hedged here
 * because unrefined it genuinely spans three states (the (!) rows above).
 */
export const shortConnectionMessage = (
  cause: ConnectionCause,
  error: unknown,
  timeoutMs: number,
): string => {
  switch (cause) {
    case "timeout":
      return `timed out after ${String(timeoutMs)} ms`;
    case "dns":
      return "hostname did not resolve";
    case "refused":
      return "could not connect (refused, unresolvable name, or wrong tls port)";
    case "reset":
      return "connection closed mid-request";
    case "protocol":
      return "the answer was not http";
    case "tls":
      return "tls handshake failed";
    case "unknown":
      return error instanceof Error ? error.message : "request failed";
  }
};

/** Wire codes per cause — what sync-state records as `code: message`. */
export const CONNECTION_FAILURE_CODES: Readonly<Record<ConnectionCause, string>> = {
  timeout: "timeout",
  dns: "dns_failure",
  refused: "connection_failed",
  reset: "connection_reset",
  protocol: "not_http",
  tls: "tls_failure",
  unknown: "network_error",
};

export type HostLookup = (host: string) => Promise<unknown>;

/**
 * Splits Bun's collapsed "could not connect" into its DNS half, for surfaces
 * where a human is waiting (login, doctor). One bounded lookup: resolves →
 * genuinely refused; rejects → the name is the problem. A lookup that HANGS
 * (a resolver behind the same dead VPN) must not hang the CLI, so the
 * deadline races it and fails toward "refused" — today's answer, not a worse
 * one. Every other cause passes through untouched, lookup never consulted.
 */
export const refineRefusedCause = async (
  cause: ConnectionCause,
  hubUrl: string,
  lookupHost: HostLookup = lookup,
  deadlineMs: number = DNS_REFINE_TIMEOUT_MS,
): Promise<ConnectionCause> => {
  if (cause !== "refused") {
    return cause;
  }
  const host = ((): string | null => {
    try {
      return new URL(hubUrl).hostname;
    } catch {
      return null;
    }
  })();
  if (host === null) {
    return "refused";
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<ConnectionCause>((resolve) => {
    timer = setTimeout(() => resolve("refused"), deadlineMs);
  });
  try {
    return await Promise.race([
      lookupHost(host).then(
        (): ConnectionCause => "refused",
        (): ConnectionCause => "dns",
      ),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
  }
};

export interface ConnectionFailureContext {
  readonly hubUrl: string;
  /** The timeout the failed call actually ran under — the number printed. */
  readonly timeoutMs: number;
}

/**
 * The full CLI sentence: cause first, url named, remedy attached. Each remedy
 * is the one that MOVES that cause — a timeout names both timeout knobs and
 * the fact that login measures; a DNS failure points at the name and the
 * VPN/tailnet serving it; refused asks about the hub process and the port.
 */
export const describeConnectionFailure = (
  cause: ConnectionCause,
  context: ConnectionFailureContext,
  rawMessage: string,
): string => {
  const { hubUrl, timeoutMs } = context;
  switch (cause) {
    case "timeout":
      return (
        `hub timed out after ${String(timeoutMs)} ms: ${hubUrl} — a far hub ` +
        "(VPN/relay latency) needs a larger timeout; rerun crosscheck login " +
        "(it measures the distance and stores a fitting timeout) or set " +
        "CROSSCHECK_TIMEOUT_MS"
      );
    case "dns":
      return (
        `cannot resolve the hub's hostname: ${hubUrl} — check the name for ` +
        "typos, and that the VPN/tailnet that serves it is connected"
      );
    case "refused":
      return (
        `connection refused: ${hubUrl} — nothing accepted the connection; ` +
        "is the hub running there, and is the port right?"
      );
    case "reset":
      return (
        `the connection was closed mid-request: ${hubUrl} — a proxy or an ` +
        "unrelated service may own that port"
      );
    case "protocol":
      return (
        `the answer was not http: ${hubUrl} — wrong port, or a proxy is in ` +
        "the way"
      );
    case "tls":
      return (
        `tls handshake failed: ${hubUrl} — https against a non-tls port, or ` +
        "an untrusted certificate"
      );
    case "unknown":
      return `hub unreachable: ${hubUrl} (${rawMessage})`;
  }
};
