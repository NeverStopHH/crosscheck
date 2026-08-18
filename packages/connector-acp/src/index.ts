/**
 * @crosscheck/connector-acp — the ACP transparent proxy (Block 3 of
 * docs/adapters/DESIGN-agent-agnostic.md). The bin's `acp` subcommand
 * imports `runAcpProxy`; everything else is exported for tests and for the
 * capture layer Blocks 4-5 will build on top.
 */
export { runAcpProxy } from "./proxy.ts";
export { ACP_USAGE, isUsageError, parseAcpArgs } from "./cli.ts";
export type { AcpInvocation, AcpUsageError } from "./cli.ts";
export { createLineObserver } from "./observer.ts";
export type { LineObserver, ObservedLine, ObserverCounters } from "./observer.ts";
export { pumpBytes } from "./pump.ts";
export type { ByteSink, ChunkObserver, PumpOutcome } from "./pump.ts";
export { createAcpLogger } from "./logger.ts";
export type { AcpLogger, AcpLoggerLimits, AppendImpl } from "./logger.ts";
export { createAcpRecorder } from "./recorder.ts";
export type { AcpRecorder, AcpRecorderLimits, RecordDirection } from "./recorder.ts";
