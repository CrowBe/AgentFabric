import { randomUUID } from 'node:crypto';
import { GatewayError, type CurationHint, type EffectiveCapability, type SecretStore, type StorageAdapter,
  type TelemetryEventFilter, type TelemetryEventRecord, type TelemetryStatus, type TraceStore } from '../types/index.js';
import { summarizeTraces } from '../storage/memory.js';

const errorStatus: Record<string, TelemetryStatus> = {
  INVALID_INPUT: 'validation_error', AUTH_REQUIRED: 'auth_required', APPROVAL_DENIED: 'approval_denied',
  APPROVAL_TIMEOUT: 'approval_timeout', CAPABILITY_NOT_FOUND: 'not_found', NOT_FOUND: 'not_found',
  FORBIDDEN: 'forbidden', CAPABILITY_DENIED: 'forbidden', REMOTE_CLI_FORBIDDEN: 'forbidden',
  PATH_OUTSIDE_SHARE: 'forbidden', PROPOSAL_NOT_ACTIVATED: 'forbidden',
};

function bytes(value: unknown) { return Buffer.byteLength(JSON.stringify(value) ?? ''); }

export class Telemetry {
  constructor(private readonly storage: StorageAdapter, private readonly secrets: SecretStore,
    private readonly trace?: TraceStore) {}

  async measure<T>(metadata: Pick<TelemetryEventRecord, 'profileId' | 'sessionId' | 'clientName' | 'toolName'
    | 'sourceId' | 'capabilityId' | 'exposureTier'>, args: unknown, operation: () => Promise<T>) {
    const start = performance.now();
    let result: T | undefined;
    let status: TelemetryStatus = 'ok';
    let code: string | undefined;
    try {
      result = await operation();
      if (result && typeof result === 'object' && Reflect.get(result, 'isError') === true) {
        status = 'upstream_error';
        code = 'UPSTREAM_ERROR';
      }
      return result;
    } catch (error) {
      code = error instanceof GatewayError ? error.code : 'UPSTREAM_ERROR';
      status = errorStatus[code] ?? 'upstream_error';
      throw error;
    } finally {
      try {
        await this.record({
          ...metadata, id: randomUUID(), timestamp: new Date().toISOString(),
          toolName: this.secrets.redact(metadata.toolName), clientName: metadata.clientName && this.secrets.redact(metadata.clientName),
          status, errorCode: code, latencyMs: performance.now() - start, inputBytes: bytes(args), outputBytes: bytes(result),
        });
      } catch {}
    }
  }

  async record(event: TelemetryEventRecord) {
    try {
      if (this.trace) await this.trace.append(event);
      else await this.storage.appendTelemetryEvent(event);
    } catch {}
  }

  query(filter?: TelemetryEventFilter) {
    return this.trace ? this.trace.query(filter) : this.storage.listTelemetryEvents(filter);
  }

  async summarize(filter?: TelemetryEventFilter) {
    return this.trace ? this.trace.summarize(filter) : summarizeTraces(await this.storage.listTelemetryEvents(filter));
  }

  async hints(caps: EffectiveCapability[], profileId: string) {
    const [summary, events] = await Promise.all([this.summarize({ profileId }), this.query({ profileId })]);
    const searches = new Map<string, number>();
    for (const event of events) {
      if (event.toolName === 'fabric_search' && event.capabilityId) {
        searches.set(event.capabilityId, (searches.get(event.capabilityId) ?? 0) + 1);
      }
    }
    const byCapability = new Map(summary.byCapability.map(row => [row.key, row]));
    const hints: CurationHint[] = [];
    for (const cap of caps) {
      if (cap.kind !== 'tool' || cap.exposure === 'hidden') continue;
      const metrics = byCapability.get(cap.id);
      const searchCount = searches.get(cap.id) ?? 0;
      const calls = Math.max(0, (metrics?.calls ?? 0) - searchCount);
      const add = (type: CurationHint['type'], message: string, values: Record<string, number>) => hints.push({
        type, capabilityId: cap.id, sourceId: cap.sourceId, toolName: cap.exposedName, message, metrics: values,
      });
      if (cap.exposure === 'searchable' && searchCount >= 3) add('frequently_searched', 'Frequently returned by targeted search', { searches: searchCount });
      if (cap.exposure === 'direct' && !calls) add('unused_direct', 'Direct capability has no recorded calls', { calls });
      if (metrics && calls >= 3 && metrics.errors / calls >= 0.25) {
        add('high_error_rate', 'Capability has a high error rate', { calls, errorRate: metrics.errors / calls });
      }
      if (metrics && calls >= 3 && metrics.p95LatencyMs >= 1000) {
        add('slow_capability', 'Capability has high p95 latency', { calls, p95LatencyMs: metrics.p95LatencyMs });
      }
    }
    return hints;
  }
}
