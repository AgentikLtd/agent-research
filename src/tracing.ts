/**
 * Tracing bootstrap for the research-agent runtime.
 *
 * Uses `BasicTracerProvider` from `@opentelemetry/sdk-trace-base` directly
 * — NOT `NodeSDK`. Rationale (memory.md 2026-05-13 #C6 audit):
 *
 *   `NodeSDK.setGlobalTracerProvider()` rejects subsequent calls, so
 *   multi-instance tests (e.g. spinning up two tracers in one process)
 *   silently keep using the first registration. Owning a
 *   `BasicTracerProvider` per call means each `initTracing()` returns
 *   an independent provider, callers hold the handle, and tests can
 *   construct as many as they need.
 *
 * The returned handle exposes `shutdown()` so consumers (the index.ts
 * boot path, integration tests) can flush pending spans on exit.
 *
 * When `otlpEndpoint` is supplied, spans are batched via
 * `BatchSpanProcessor` (production behaviour: amortise HTTP round-trips,
 * survive bursty workloads). When omitted, the provider is created with
 * no processors — spans are still constructed and parented correctly
 * (so business code that reads the current span ID stays consistent),
 * but nothing leaves the process. This is the right default for local
 * dev and unit tests that haven't booted a collector.
 */

import type { Tracer } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

export interface TracingHandle {
  /** Per-instance OTel tracer keyed by the service name. */
  readonly tracer: Tracer;
  /** Flushes pending spans and closes the exporter (if any). */
  shutdown(): Promise<void>;
}

/**
 * Initialise a tracer bound to `serviceName`. If `otlpEndpoint` is
 * provided, spans are batched and exported via OTLP/HTTP to
 * `${otlpEndpoint}/v1/traces`. Otherwise the provider has no
 * processors and acts as a no-op exporter.
 *
 * Returns a handle whose `shutdown()` callers MUST invoke at process
 * exit to avoid losing buffered spans.
 */
export function initTracing(serviceName: string, otlpEndpoint?: string): TracingHandle {
  const processors: SpanProcessor[] = [];
  if (otlpEndpoint !== undefined && otlpEndpoint.length > 0) {
    processors.push(
      new BatchSpanProcessor(
        new OTLPTraceExporter({ url: `${otlpEndpoint.replace(/\/$/, '')}/v1/traces` }),
      ),
    );
  }

  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
    spanProcessors: processors,
  });

  // Pull the tracer off the OWN provider, not the global registry
  // (`trace.getTracer` would return a no-op since we deliberately skip
  // `setGlobalTracerProvider` — see header comment).
  return {
    tracer: provider.getTracer(serviceName),
    async shutdown() {
      await provider.shutdown();
    },
  };
}
