/**
 * `crosscheck acp-report <record-file>` — the §6.1 capture-quality analyzer.
 * Replays a `--record` transcript through the same wire classifier capture
 * uses and reports which signals the recorded agent ACTUALLY emitted:
 * locations? diff paths? terminals? fs writes? That report is what decides
 * the per-agent documentation ("if an agent reports edits without paths, its
 * Tier-0 capture degrades to fs/terminal signals and the doc for that agent
 * should say so" — design §6 open question 1).
 *
 * LEAN ON PURPOSE: counts and presence verdicts only. No file contents, no
 * prompt text, no command text ever appear in the report — every untrusted
 * wire string is reduced before it renders: the agent name through
 * `agentSlug`, the version and stop reasons through their own narrow
 * alphabets (`safeWireField` below); everything else is numbers. This module
 * never writes to stdout — the CLI layer prints the returned text (the
 * package-wide no-stdout-writers pin, proxy.ts VERIFY).
 */
import { readFile } from "node:fs/promises";

import { EXIT_FAIL, EXIT_OK } from "@crosscheck/connector-core/constants.ts";
import { extractFailureText } from "@crosscheck/connector-core/capture/failure-text.ts";
import { agentSlug } from "@crosscheck/connector-core/state/host-session-key.ts";

import { createPendingMap } from "./capture/pending.ts";
import {
  WIRE_METHODS,
  classifyWireMessage,
  parseInitializeResult,
  parseSessionUpdateParams,
  parseSessionPromptResult,
  parseTerminalExitResult,
  parseTerminalOutputResult,
} from "./wire/v1.ts";

export interface AcpRecordReport {
  /** Slugged (narrow charset) — the raw wire name never prints. */
  readonly agentName: string | null;
  /** Reduced to version characters — the raw wire string never prints. */
  readonly agentVersion: string | null;
  readonly protocolVersion: number | null;
  readonly sessions: {
    readonly new: number;
    readonly load: number;
    readonly resume: number;
  };
  readonly prompts: number;
  readonly stopReasons: Readonly<Record<string, number>>;
  readonly toolCalls: {
    readonly events: number;
    readonly withLocations: number;
    readonly withDiffPaths: number;
    readonly distinctPaths: number;
    readonly failed: number;
    readonly failedWithOutput: number;
  };
  readonly terminals: {
    readonly created: number;
    readonly outputs: number;
    readonly nonZeroExits: number;
  };
  readonly fsWrites: number;
  /**
   * `agent_message_chunk` updates carrying text — Tier-1 slice source 1, and
   * the only one of the three that is not already a capture signal. Counted
   * here so `acp-report` can answer the question the summarizer rung's
   * REDUCED sentence raises: how much of the wire does THIS agent fill?
   */
  readonly agentMessages: number;
  readonly lines: number;
  readonly unparseable: number;
  readonly gaps: number;
  readonly oversized: number;
}

interface RecordEntry {
  readonly dir?: string;
  readonly line?: string;
  readonly parsed?: boolean;
  readonly gap?: number;
  readonly oversized?: number;
}

/**
 * The wire's OTHER untrusted strings, reduced before they may render:
 * `agentInfo.version` keeps version punctuation, a stop reason keeps its
 * snake_case token shape. Anything outside the alphabet — ANSI escapes,
 * newlines, prose separators — is stripped, the remainder is length-capped,
 * and an emptied value drops to null (renders as absent). The agent NAME
 * already goes through `agentSlug`; these two were the header's blind spot.
 */
const VERSION_ALPHABET = /[^0-9A-Za-z._+-]/g;
const STOP_REASON_ALPHABET = /[^0-9A-Za-z_-]/g;
const MAX_WIRE_FIELD_CHARS = 40;

const safeWireField = (raw: string, disallowed: RegExp): string | null => {
  const shaped = raw.replace(disallowed, "").slice(0, MAX_WIRE_FIELD_CHARS);
  return shaped.length === 0 ? null : shaped;
};

const parseEntry = (raw: string): RecordEntry | null => {
  try {
    const value = JSON.parse(raw) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as RecordEntry)
      : null;
  } catch {
    return null;
  }
};

export const analyzeAcpRecord = (text: string): AcpRecordReport => {
  let agentName: string | null = null;
  let agentVersion: string | null = null;
  let protocolVersion: number | null = null;
  const sessions = { new: 0, load: 0, resume: 0 };
  let prompts = 0;
  const stopReasons: Record<string, number> = {};
  const toolCalls = {
    events: 0,
    withLocations: 0,
    withDiffPaths: 0,
    failed: 0,
    failedWithOutput: 0,
  };
  const distinctPaths = new Set<string>();
  const terminals = { created: 0, outputs: 0, nonZeroExits: 0 };
  let fsWrites = 0;
  let agentMessages = 0;
  let lines = 0;
  let unparseable = 0;
  let gaps = 0;
  let oversized = 0;

  // The record interleaves both directions, so the analyzer keeps the same
  // two pending maps capture does — the correlation logic is re-USED, never
  // re-invented.
  const pendingClient = createPendingMap();
  const pendingAgent = createPendingMap();

  for (const raw of text.split("\n")) {
    if (raw.trim().length === 0) {
      continue;
    }
    const entry = parseEntry(raw);
    if (entry === null) {
      continue;
    }
    if (typeof entry.gap === "number") {
      gaps += entry.gap;
      continue;
    }
    if (typeof entry.oversized === "number") {
      oversized += 1;
      continue;
    }
    if (typeof entry.line !== "string") {
      continue;
    }
    lines += 1;
    if (entry.parsed === false) {
      unparseable += 1;
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(entry.line);
    } catch {
      unparseable += 1;
      continue;
    }
    const message = classifyWireMessage(value);
    if (message === null) {
      continue;
    }
    const direction = entry.dir === "c2a" ? "c2a" : "a2c";

    if (message.kind === "request" || message.kind === "notification") {
      if (message.kind === "request") {
        (direction === "c2a" ? pendingClient : pendingAgent).put(message.id, {
          method: message.method,
          params: message.params,
        });
      }
      switch (message.method) {
        case WIRE_METHODS.sessionNew:
          sessions.new += 1;
          break;
        case WIRE_METHODS.sessionLoad:
          sessions.load += 1;
          break;
        case WIRE_METHODS.sessionResume:
          sessions.resume += 1;
          break;
        case WIRE_METHODS.sessionPrompt:
          prompts += 1;
          break;
        case WIRE_METHODS.fsWriteTextFile:
          fsWrites += 1;
          break;
        case WIRE_METHODS.terminalCreate:
          terminals.created += 1;
          break;
        case WIRE_METHODS.sessionUpdate: {
          const update = parseSessionUpdateParams(message.params);
          if (update?.agentText !== null && update?.agentText !== undefined) {
            agentMessages += 1;
          }
          const toolCall = update?.toolCall ?? null;
          if (toolCall === null) {
            break;
          }
          toolCalls.events += 1;
          if (toolCall.paths.length > 0) {
            toolCalls.withLocations += 1;
          }
          for (const path of toolCall.paths) {
            distinctPaths.add(path);
          }
          if (toolCall.status === "failed") {
            toolCalls.failed += 1;
            if (extractFailureText(toolCall.rawOutput).length > 0) {
              toolCalls.failedWithOutput += 1;
            }
          }
          break;
        }
        default:
          break;
      }
      // Diff-path presence needs the raw update rows, not the merged list.
      //
      // `content` IS NOT ALWAYS AN ARRAY, and assuming it was crashed this
      // whole command: a tool call's content is an array of rows, but an
      // `agent_message_chunk`'s is a single ContentBlock OBJECT, and one
      // `.some` on an object throws. Every real agent streams message
      // chunks, so `crosscheck acp-report` threw on essentially any real
      // recording — invisible only because the fixture here used tool calls
      // exclusively. wire/v1.ts documents the same two-shapes-one-key fact
      // where it parses it; this is the raw-scan side of it.
      if (message.method === WIRE_METHODS.sessionUpdate) {
        const params = message.params as
          | { update?: { content?: unknown } }
          | undefined;
        const content = params?.update?.content;
        if (
          Array.isArray(content) &&
          content.some(
            (row: { type?: string; path?: string } | null) =>
              row?.type === "diff" && typeof row?.path === "string",
          )
        ) {
          toolCalls.withDiffPaths += 1;
        }
      }
      continue;
    }

    // Responses: correlate through the opposite direction's pending map.
    const request = (direction === "a2c" ? pendingClient : pendingAgent).take(
      message.id,
    );
    if (request === null || message.isError) {
      continue;
    }
    if (request.method === WIRE_METHODS.initialize) {
      const initialized = parseInitializeResult(message.result);
      agentName = initialized.agentName === null ? null : agentSlug(initialized.agentName);
      agentVersion =
        initialized.agentVersion === null
          ? null
          : safeWireField(initialized.agentVersion, VERSION_ALPHABET);
      protocolVersion = initialized.protocolVersion;
    } else if (request.method === WIRE_METHODS.sessionPrompt) {
      const { stopReason } = parseSessionPromptResult(message.result);
      const shaped =
        stopReason === null
          ? null
          : safeWireField(stopReason, STOP_REASON_ALPHABET);
      if (shaped !== null) {
        stopReasons[shaped] = (stopReasons[shaped] ?? 0) + 1;
      }
    } else if (request.method === WIRE_METHODS.terminalOutput) {
      terminals.outputs += 1;
      const output = parseTerminalOutputResult(message.result);
      if (output.exitCode !== null && output.exitCode !== 0) {
        terminals.nonZeroExits += 1;
      }
    } else if (request.method === WIRE_METHODS.terminalWaitForExit) {
      const exit = parseTerminalExitResult(message.result);
      if (exit.exitCode !== null && exit.exitCode !== 0) {
        terminals.nonZeroExits += 1;
      }
    }
  }

  return {
    agentName,
    agentVersion,
    protocolVersion,
    sessions,
    prompts,
    stopReasons,
    toolCalls: { ...toolCalls, distinctPaths: distinctPaths.size },
    terminals,
    fsWrites,
    agentMessages,
    lines,
    unparseable,
    gaps,
    oversized,
  };
};

const NONE_SEEN = "none seen";

const signal = (present: boolean, detail: string): string =>
  present ? detail : NONE_SEEN;

/**
 * THE PER-AGENT DEGRADE, PRINTED AS A FACT rather than left to be discovered.
 *
 * The summarizer rung on this host is REDUCED for one reason: the turn slice
 * is only what the wire happens to carry. That is a sentence in the
 * capability manifest, and it is worth exactly as much as the reader's ability
 * to check it — so this says which of the three sources the RECORDED agent
 * actually emitted, and what that costs.
 *
 * `git commit` is the concrete case: the gate's commit-boundary anchor looks
 * for it as a COMMAND, terminal command text is modelled by no schema here,
 * and an agent that shells out without ACP's terminal/* methods therefore
 * gives a slice with no executed shape in it at all. A conclusion in such a
 * slice fires only through the prose wing, and this line is what makes that
 * explainable instead of mysterious.
 */
const sliceVerdict = (report: AcpRecordReport): string => {
  const executed =
    report.toolCalls.failedWithOutput > 0 || report.terminals.outputs > 0;
  if (report.agentMessages === 0 && !executed) {
    return "nothing — this agent emitted no prose, no failure output and no terminal output, so a turn slice would be empty and the gate never fires";
  }
  if (!executed) {
    return "prose only — this agent does its work outside ACP's terminal/* and reports no failure output, so a conclusion never has an executed shape beside it and only the prose wing can fire";
  }
  if (report.agentMessages === 0) {
    return "executed shapes only — this agent emits no message chunks, so the gate sees what ran but never what the agent concluded about it";
  }
  return "prose and executed shapes — this agent fills every source the Tier-1 slice can read";
};

export const renderAcpRecordReport = (report: AcpRecordReport): string => {
  const stopReasons = Object.entries(report.stopReasons)
    .map(([reason, count]) => `${reason}=${count}`)
    .join(" ");
  return [
    `agent: ${report.agentName ?? "unknown"}${
      report.agentVersion === null ? "" : ` ${report.agentVersion}`
    } (protocol ${report.protocolVersion ?? "unknown"})`,
    `wire: ${report.lines} lines, ${report.unparseable} unparseable, ${report.gaps} gaps, ${report.oversized} oversized`,
    `sessions: new=${report.sessions.new} load=${report.sessions.load} resume=${report.sessions.resume}`,
    `prompts: ${report.prompts}${stopReasons.length === 0 ? "" : ` (${stopReasons})`}`,
    "capture signals:",
    `  tool calls:  ${signal(report.toolCalls.events > 0, `${report.toolCalls.events} events`)}`,
    `  locations:   ${signal(
      report.toolCalls.withLocations > 0,
      `${report.toolCalls.withLocations} events, ${report.toolCalls.distinctPaths} distinct paths`,
    )}`,
    `  diff paths:  ${signal(report.toolCalls.withDiffPaths > 0, `${report.toolCalls.withDiffPaths} events`)}`,
    `  failures:    ${signal(
      report.toolCalls.failed > 0,
      `${report.toolCalls.failed} failed, ${report.toolCalls.failedWithOutput} with output`,
    )}`,
    `  terminals:   ${signal(
      report.terminals.created > 0,
      `${report.terminals.created} created, ${report.terminals.outputs} outputs, ${report.terminals.nonZeroExits} non-zero exits`,
    )}`,
    `  fs writes:   ${signal(report.fsWrites > 0, `${report.fsWrites} writes`)}`,
    "tier-1 slice sources:",
    `  agent prose:    ${signal(report.agentMessages > 0, `${report.agentMessages} message chunks`)}`,
    `  failure text:   ${signal(
      report.toolCalls.failedWithOutput > 0,
      `${report.toolCalls.failedWithOutput} failed tool calls with output`,
    )}`,
    `  terminal tails: ${signal(report.terminals.outputs > 0, `${report.terminals.outputs} outputs`)}`,
    `  verdict: ${sliceVerdict(report)}`,
    "",
  ].join("\n");
};

export interface AcpReportResult {
  readonly stdout: string;
  readonly exitCode: number;
}

/** Reads and renders; the CLI layer prints. Never throws. */
export const runAcpReport = async (path: string): Promise<AcpReportResult> => {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return {
      stdout: `crosscheck acp-report: cannot read ${path}\n`,
      exitCode: EXIT_FAIL,
    };
  }
  try {
    return {
      stdout: renderAcpRecordReport(analyzeAcpRecord(text)),
      exitCode: EXIT_OK,
    };
  } catch {
    // The analyzer walks an UNTRUSTED file — a recording is whatever some
    // agent wrote plus whatever happened to the disk. A shape it did not
    // expect must be a sentence, exactly as an unreadable file already is,
    // and never a stack trace: this is a development aid, and one that dies
    // loudly teaches people to stop running it.
    return {
      stdout: `crosscheck acp-report: ${path} is not a readable wire recording\n`,
      exitCode: EXIT_FAIL,
    };
  }
};
