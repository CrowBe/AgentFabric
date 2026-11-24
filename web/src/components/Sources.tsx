import { useMemo, useState } from 'react';
import { Switch, SwitchThumb } from '@ui-sdk/react/switch';
import { PlusIcon, RefreshCwIcon, TrashIcon, ZapIcon } from 'lucide-react';
import type { CapabilityKind } from '../../../src/types/index.js';
import { api, type EffectiveCapability, type SourceRecord, type SourceTestResult } from '../api';
import { AddSourceDialog } from './AddSourceDialog';
import { OverlayEditor } from './OverlayEditor';
import { KIND_LABELS } from './source-forms';
import {
  Button,
  Card,
  DataTable,
  HealthPill,
  LoadState,
  Notice,
  Pill,
  SelectField,
  TextField,
  ask,
  attempt,
  formatRelative,
  useResource,
} from './ui';

const ALL = '__all';

export function Sources() {
  const status = useResource(() => api.status(), []);
  const sources = useResource(() => api.sources(), []);
  const profiles = useResource(() => api.profiles(), []);
  const [profileId, setProfileId] = useState('');
  const pool = useResource(() => api.capabilities(profileId ? { profileId } : {}), [profileId]);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<EffectiveCapability | null>(null);
  const [results, setResults] = useState<Record<string, SourceTestResult>>({});
  const [query, setQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState(ALL);
  const [kindFilter, setKindFilter] = useState(ALL);

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const cap of pool.data ?? []) map.set(cap.sourceId, (map.get(cap.sourceId) ?? 0) + 1);
    return map;
  }, [pool.data]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (pool.data ?? []).filter(
      (cap) =>
        (sourceFilter === ALL || cap.sourceId === sourceFilter) &&
        (kindFilter === ALL || cap.kind === (kindFilter as CapabilityKind)) &&
        (!q ||
          cap.exposedName.toLowerCase().includes(q) ||
          cap.originalName.toLowerCase().includes(q) ||
          cap.description.toLowerCase().includes(q) ||
          cap.tags.some((tag) => tag.toLowerCase().includes(q))),
    );
  }, [pool.data, query, sourceFilter, kindFilter]);

  const refreshAll = () => Promise.all([sources.reload(), pool.reload()]);

  async function test(source: SourceRecord) {
    const result = await attempt(() => api.testSource(source.id));
    if (result) setResults((r) => ({ ...r, [source.id]: result }));
    await sources.reload();
  }
  async function refresh(source: SourceRecord) {
    if (await attempt(() => api.refreshSource(source.id), `Refreshed ${source.name}`)) await refreshAll();
  }
  async function toggle(source: SourceRecord, enabled: boolean) {
    if (await attempt(() => api.updateSource(source.id, { enabled }))) await refreshAll();
  }
  async function remove(source: SourceRecord) {
    const yes = await ask(
      `Delete ${source.name}?`,
      'Its capabilities leave the pool and any overlays on them are removed. Profiles keep their rules.',
      'Delete source',
    );
    if (yes && (await attempt(() => api.deleteSource(source.id), `Deleted ${source.name}`))) await refreshAll();
  }

  const sourceOptions = [{ value: ALL, label: 'All sources' }, ...(sources.data ?? []).map((s) => ({ value: s.id, label: s.name }))];

  return (
    <div className="stack">
      <h1>Sources &amp; Pool</h1>
      <Card
        title="Sources"
        description="Upstreams pass straight through to the pool. Failures stay inside their own source."
        actions={
          <Button data-variant="solid" onClick={() => setAdding(true)}>
            <PlusIcon aria-hidden="true" /> Add source
          </Button>
        }
      >
        <LoadState resource={sources} label="sources" />
        <DataTable
          caption="Configured sources"
          empty="No sources yet. Add one from a starter recipe or build a custom source."
          rows={sources.data ?? []}
          rowKey={(s) => s.id}
          columns={[
            {
              header: 'Source',
              rowHeader: true,
              cell: (s) => (
                <>
                  <strong>{s.name}</strong>
                  <br />
                  <small className="muted mono">{s.id}</small>
                </>
              ),
            },
            { header: 'Kind', cell: (s) => KIND_LABELS[s.kind] },
            {
              header: 'Health',
              cell: (s) => (
                <>
                  <HealthPill health={s.health} />
                  {s.lastError ? <small className="muted block">{s.lastError}</small> : null}
                </>
              ),
            },
            { header: 'Capabilities', cell: (s) => counts.get(s.id) ?? 0, align: 'end' },
            { header: 'Refreshed', cell: (s) => formatRelative(s.lastRefreshedAt) },
            {
              header: 'Enabled',
              cell: (s) => (
                <Switch aria-label={`Enable ${s.name}`} checked={s.enabled} onCheckedChange={(next: boolean) => void toggle(s, next)}>
                  <SwitchThumb />
                </Switch>
              ),
            },
            {
              header: 'Actions',
              cell: (s) => (
                <div className="row wrap">
                  <Button data-size="sm" onClick={() => test(s)} aria-label={`Test ${s.name}`}>
                    <ZapIcon aria-hidden="true" /> Test
                  </Button>
                  <Button data-size="sm" onClick={() => refresh(s)} aria-label={`Refresh ${s.name}`}>
                    <RefreshCwIcon aria-hidden="true" /> Refresh
                  </Button>
                  <Button data-size="sm" data-variant="destructive" onClick={() => remove(s)} aria-label={`Delete ${s.name}`}>
                    <TrashIcon aria-hidden="true" /> Delete
                  </Button>
                </div>
              ),
            },
          ]}
        />
        {Object.entries(results).map(([id, result]) => {
          const source = sources.data?.find((s) => s.id === id);
          return (
            <Notice key={id} tone={result.ok ? 'ok' : 'warn'} title={`Test: ${source?.name ?? id}`}>
              {result.ok ? 'Reachable' : 'Not usable'} · {result.health.replace('_', ' ')} · {result.latencyMs} ms ·{' '}
              {result.capabilityCount} capabilities
              {result.error ? <> · {result.error}</> : null}
              {result.authHandoff ? (
                <p>
                  Credentials needed:{' '}
                  <a href={result.authHandoff.authUrl} target="_blank" rel="noopener noreferrer">
                    open the gateway auth page
                  </a>
                  {result.authHandoff.cliCommand ? (
                    <>
                      {' '}
                      or run <code>{result.authHandoff.cliCommand}</code>
                    </>
                  ) : null}
                  .
                </p>
              ) : null}
            </Notice>
          );
        })}
      </Card>

      <Card
        title="Capability pool"
        description="Everything agents can reach. Normalisation is an opt-in overlay you finalise."
      >
        <LoadState resource={pool} label="capabilities" />
        <div className="filters">
          <TextField label="Search" value={query} onChange={setQuery} placeholder="name, description, tag" />
          <SelectField label="Source" value={sourceFilter} onChange={setSourceFilter} options={sourceOptions} />
          <SelectField
            label="Kind"
            value={kindFilter}
            onChange={setKindFilter}
            options={[
              { value: ALL, label: 'All kinds' },
              { value: 'tool', label: 'Tools' },
              { value: 'prompt', label: 'Prompts' },
              { value: 'resource', label: 'Resources' },
              { value: 'skill', label: 'Skills' },
            ]}
          />
          <SelectField
            label="Exposure as profile"
            value={profileId || (profiles.data?.[0]?.id ?? '')}
            onChange={setProfileId}
            options={(profiles.data ?? []).map((p) => ({ value: p.id, label: p.name }))}
          />
        </div>
        <p className="muted" role="status">
          Showing {filtered.length} of {pool.data?.length ?? 0} capabilities
        </p>
        <DataTable
          caption="Pooled capabilities"
          empty="No capabilities match."
          rows={filtered}
          rowKey={(c) => c.id}
          columns={[
            {
              header: 'Capability',
              rowHeader: true,
              cell: (c) => (
                <>
                  <strong>{c.exposedName}</strong>
                  {c.exposedName !== c.originalName ? <small className="muted block mono">was {c.originalName}</small> : null}
                </>
              ),
            },
            { header: 'Kind', cell: (c) => c.kind },
            { header: 'Source', cell: (c) => c.sourceName },
            { header: 'Group', cell: (c) => c.semanticGroup },
            { header: 'Exposure', cell: (c) => <Pill tone={c.exposure === 'direct' ? 'info' : c.exposure === 'hidden' ? 'muted' : 'ok'}>{c.exposure}</Pill> },
            {
              header: 'Permission',
              cell: (c) => <Pill tone={c.permission === 'allow' ? 'ok' : c.permission === 'deny' ? 'bad' : 'warn'}>{c.permission.replace('_', ' ')}</Pill>,
            },
            {
              header: 'Status',
              cell: (c) => (c.available ? <Pill tone="ok">available</Pill> : <Pill tone="bad">{c.availabilityReason ?? 'unavailable'}</Pill>),
            },
            { header: 'Overlay', cell: (c) => (c.hasOverlay ? <Pill tone="info">applied</Pill> : <span className="muted">—</span>) },
            {
              header: 'Actions',
              cell: (c) => (
                <Button data-size="sm" onClick={() => setEditing(c)} aria-label={`Normalise ${c.exposedName}`}>
                  Normalise…
                </Button>
              ),
            },
          ]}
        />
      </Card>

      <AddSourceDialog
        open={adding}
        onClose={() => setAdding(false)}
        onCreated={() => void refreshAll()}
        mode={status.data?.mode ?? 'local'}
      />
      <OverlayEditor capability={editing} onClose={() => setEditing(null)} onChanged={() => void pool.reload()} />
    </div>
  );
}
