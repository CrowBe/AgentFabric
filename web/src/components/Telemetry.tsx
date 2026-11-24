import { useRef, useState } from 'react';
import { Meter, MeterIndicator, MeterTrack } from '@ui-sdk/react/meter';
import { DownloadIcon, UploadIcon } from 'lucide-react';
import { api, describeError, type TelemetrySummary } from '../api';
import {
  Button,
  Card,
  DataTable,
  LoadState,
  Notice,
  Pill,
  SelectField,
  Stat,
  SwitchField,
  TextAreaField,
  ask,
  attempt,
  formatMs,
  formatPercent,
  formatTime,
  notify,
  useResource,
  type Column,
} from './ui';

const ALL = '__all';
const WINDOWS: Record<string, number | undefined> = { '1h': 3600, '24h': 86_400, '7d': 604_800, all: undefined };

export function Telemetry() {
  const profiles = useResource(() => api.profiles(), []);
  const sources = useResource(() => api.sources(), []);
  const [profileId, setProfileId] = useState(ALL);
  const [sourceId, setSourceId] = useState(ALL);
  const [windowKey, setWindowKey] = useState('24h');
  const filter = {
    ...(profileId !== ALL ? { profileId } : {}),
    ...(sourceId !== ALL ? { sourceId } : {}),
  };
  const seconds = WINDOWS[windowKey];
  const summary = useResource(
    () =>
      api.telemetrySummary({
        ...filter,
        ...(seconds ? { since: new Date(Date.now() - seconds * 1000).toISOString() } : {}),
      }),
    [profileId, sourceId, windowKey],
    { intervalMs: 30_000 },
  );
  const traces = useResource(() => api.telemetryEvents({ ...filter, limit: 50 }), [profileId, sourceId], { intervalMs: 30_000 });
  const hints = useResource(() => api.curationHints(profileId !== ALL ? profileId : undefined), [profileId]);
  const s = summary.data;

  return (
    <div className="stack">
      <h1>Telemetry &amp; Portability</h1>
      <Card title="Deterministic telemetry" description="Calls, latency, errors, and session facts. Informs your curation; never reshuffles anything on its own.">
        <div className="filters">
          <SelectField label="Profile" value={profileId} onChange={setProfileId} options={[{ value: ALL, label: 'All profiles' }, ...(profiles.data ?? []).map((p) => ({ value: p.id, label: p.name }))]} />
          <SelectField label="Source" value={sourceId} onChange={setSourceId} options={[{ value: ALL, label: 'All sources' }, ...(sources.data ?? []).map((x) => ({ value: x.id, label: x.name }))]} />
          <SelectField
            label="Window"
            value={windowKey}
            onChange={setWindowKey}
            options={[
              { value: '1h', label: 'Last hour' },
              { value: '24h', label: 'Last 24 hours' },
              { value: '7d', label: 'Last 7 days' },
              { value: 'all', label: 'All time' },
            ]}
          />
        </div>
        <LoadState resource={summary} label="telemetry" />
        {s ? (
          <>
            <dl className="stats">
              <Stat label="Calls" value={s.totalCalls.toLocaleString()} />
              <Stat label="Error rate" value={formatPercent(s.errorRate)} hint={`${s.errorCount.toLocaleString()} errors`} />
              <Stat label="p50 latency" value={formatMs(s.p50LatencyMs)} />
              <Stat label="p95 latency" value={formatMs(s.p95LatencyMs)} />
            </dl>
            <p className="row wrap" aria-label="Calls by status">
              {Object.entries(s.byStatus).map(([status, count]) => (
                <Pill key={status} tone={status === 'ok' ? 'ok' : 'warn'}>
                  {status.replace('_', ' ')} · {count}
                </Pill>
              ))}
            </p>
            <Breakdown title="By source" rows={s.bySource} />
            <Breakdown title="By capability" rows={s.byCapability} />
            <Breakdown title="By profile" rows={s.byProfile} />
          </>
        ) : null}
      </Card>

      <Card title="Curation hints" description="Suggestions from deterministic facts. They never change exposure by themselves; you decide.">
        <LoadState resource={hints} label="hints" />
        <DataTable
          caption="Curation hints"
          empty="No hints right now."
          rows={hints.data ?? []}
          rowKey={(h) => `${h.type}:${h.capabilityId}`}
          columns={[
            { header: 'Hint', rowHeader: true, cell: (h) => <Pill tone={h.type === 'high_error_rate' ? 'bad' : 'info'}>{h.type.replace(/_/g, ' ')}</Pill> },
            { header: 'Capability', cell: (h) => <code>{h.toolName}</code> },
            { header: 'Why', cell: (h) => h.message },
            { header: 'Metrics', cell: (h) => Object.entries(h.metrics).map(([k, v]) => `${k} ${Number.isInteger(v) ? v : v.toFixed(2)}`).join(' · ') },
          ]}
        />
      </Card>

      <Card title="Recent traces" description="Latest calls, newest first.">
        <LoadState resource={traces} label="traces" />
        <DataTable
          caption="Recent calls"
          empty="No calls recorded yet."
          rows={traces.data ?? []}
          rowKey={(e) => e.id}
          columns={[
            { header: 'Time', rowHeader: true, cell: (e) => formatTime(e.timestamp) },
            { header: 'Tool', cell: (e) => <code>{e.toolName}</code> },
            { header: 'Profile', cell: (e) => e.profileId },
            { header: 'Client', cell: (e) => e.clientName ?? '—' },
            { header: 'Exposure', cell: (e) => e.exposureTier ?? '—' },
            { header: 'Status', cell: (e) => <Pill tone={e.status === 'ok' ? 'ok' : 'warn'}>{e.status.replace('_', ' ')}</Pill> },
            { header: 'Latency', cell: (e) => formatMs(e.latencyMs), align: 'end' },
            { header: 'In / out bytes', cell: (e) => `${e.inputBytes} / ${e.outputBytes}`, align: 'end' },
          ]}
        />
      </Card>

      <Portability />
    </div>
  );
}

function Breakdown({ title, rows }: { title: string; rows: TelemetrySummary['bySource'] }) {
  const columns: Column<TelemetrySummary['bySource'][number]>[] = [
    { header: title.replace('By ', ''), rowHeader: true, cell: (r) => r.label ?? r.key },
    { header: 'Calls', cell: (r) => r.calls.toLocaleString(), align: 'end' },
    {
      header: 'Error rate',
      cell: (r) => (
        <span className="meter-cell">
          <Meter value={r.errorRate * 100} min={0} max={100} aria-label={`Error rate ${r.label ?? r.key}`} format={() => formatPercent(r.errorRate)}>
            <MeterTrack>
              <MeterIndicator />
            </MeterTrack>
          </Meter>
          {formatPercent(r.errorRate)}
        </span>
      ),
    },
    { header: 'Avg latency', cell: (r) => formatMs(r.avgLatencyMs), align: 'end' },
    { header: 'p95 latency', cell: (r) => formatMs(r.p95LatencyMs), align: 'end' },
  ];
  return (
    <div>
      <h3>{title}</h3>
      <DataTable caption={title} empty="No calls in this view." rows={rows} columns={columns} rowKey={(r) => r.key} />
    </div>
  );
}

function Portability() {
  const [merge, setMerge] = useState(true);
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<string>();
  const fileInput = useRef<HTMLInputElement>(null);

  async function exportConfig() {
    const bundle = await attempt(() => api.exportConfig());
    if (!bundle) return;
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `agentfabric-config-${bundle.exportedAt.slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
    notify.success('Exported', 'Secret-free configuration downloaded.');
  }

  async function importConfig() {
    setError(undefined);
    setResult(undefined);
    let bundle: unknown;
    try {
      bundle = JSON.parse(text);
    } catch {
      setError('That is not valid JSON.');
      return;
    }
    if (
      !merge &&
      !(await ask(
        'Replace existing configuration?',
        'Existing sources, overlays and policies are replaced by this bundle. Export first if you might want them back.',
        'Replace',
      ))
    ) {
      return;
    }
    try {
      const done = await api.importConfig(bundle, merge);
      setResult(`Imported ${done.importedSources} sources, ${done.importedProfiles} profiles, ${done.importedOverlays} overlays, ${done.importedPolicies} policies.`);
      notify.success('Configuration imported');
    } catch (caught) {
      setError(describeError(caught));
    }
  }

  return (
    <Card title="Portability" description="Move your pool between machines and share setups. Exports never contain secret values.">
      <div className="row">
        <Button data-variant="solid" onClick={exportConfig}>
          <DownloadIcon aria-hidden="true" /> Export configuration
        </Button>
      </div>
      <div className="stack">
        <h3>Import configuration</h3>
        <div className="row wrap">
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            aria-label="Choose a configuration file"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (file) setText(await file.text());
            }}
          />
        </div>
        <TextAreaField label="Configuration JSON" value={text} onChange={setText} rows={8} mono description="Choose a file or paste an exported bundle." />
        <SwitchField label="Merge with existing configuration" checked={merge} onChange={setMerge} description={merge ? 'Existing entries are kept.' : 'Existing sources, overlays and policies are replaced.'} />
        {error ? <Notice tone="error">{error}</Notice> : null}
        {result ? <Notice tone="ok">{result}</Notice> : null}
        <div className="row">
          <Button onClick={importConfig} disabled={!text.trim()}>
            <UploadIcon aria-hidden="true" /> Import
          </Button>
        </div>
      </div>
    </Card>
  );
}
