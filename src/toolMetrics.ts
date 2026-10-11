/**
 * Ask C4S - Copyright (c) 2026 Pavan Kumar Sunkara <sunkara.leo@gmail.com>
 * All rights reserved. Proprietary and confidential.
 * Use subject to the terms in LICENSE.
 */

/**
 * In-process call counters for MCP tools — drives the /admin Tools tab.
 * Resets on server restart by design (point-in-time visibility, not history).
 */

export type ToolCall = {
  calls: number;
  cacheHits: number;
  cacheMisses: number;
  errors: number;
  totalMs: number;
  lastAt: number | null;
  lastMs: number | null;
  lastSource: "cache" | "sap" | "error" | null;
};

const metrics = new Map<string, ToolCall>();

function ensure(name: string): ToolCall {
  let m = metrics.get(name);
  if (!m) {
    m = {
      calls: 0,
      cacheHits: 0,
      cacheMisses: 0,
      errors: 0,
      totalMs: 0,
      lastAt: null,
      lastMs: null,
      lastSource: null,
    };
    metrics.set(name, m);
  }
  return m;
}

export type CallOutcome = "cache" | "sap" | "error";

export function recordCall(name: string, durationMs: number, outcome: CallOutcome) {
  const m = ensure(name);
  m.calls += 1;
  m.totalMs += durationMs;
  m.lastAt = Date.now();
  m.lastMs = Math.round(durationMs);
  m.lastSource = outcome;
  if (outcome === "cache") m.cacheHits += 1;
  else if (outcome === "sap") m.cacheMisses += 1;
  else m.errors += 1;
}

export function getMetrics(): Record<string, ToolCall> {
  const out: Record<string, ToolCall> = {};
  for (const [name, m] of metrics.entries()) out[name] = { ...m };
  return out;
}

export function resetMetrics(name?: string) {
  if (name) metrics.delete(name);
  else metrics.clear();
}
