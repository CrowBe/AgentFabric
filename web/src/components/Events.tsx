import { useState } from 'react';
import { SendIcon, TrashIcon } from 'lucide-react';
import { api, describeError, type McpEventOccurrence } from '../api';
import {
  Button,
  Card,
  CodeBlock,
  DataTable,
  LoadState,
  Notice,
  Pill,
  SelectField,
  SwitchField,
  TextAreaField,
  TextField,
  ask,
  attempt,
  formatTime,
  json,
  notify,
  parseJsonObject,
  useResource,
} from './ui';

const ALL = '__all';

export function Events() {
  const types = useResource(() => api.eventTypes(), []);
  const subscriptions = useResource(() => api.eventSubscriptions(), [], { intervalMs: 15_000 });
  const [name, setName] = useState(ALL);
  const [live, setLive] = useState(true);
  const occurrences = useResource(
    () => api.eventOccurrences({ ...(name !== ALL ? { name } : {}), limit: 100, order: 'desc' }),
    [name],
    { intervalMs: live ? 5000 : undefined },
  );

  const typeOptions = (types.data ?? []).map((t) => ({ value: t.name, label: t.name }));
  const rows = occurrences.data ?? [];

  async function removeSubscription(id: string) {
    if (!(await ask('Delete subscription?', 'The subscriber stops receiving this event until it subscribes again.', 'Delete'))) return;
    if (await attempt(() => api.deleteEventSubscription(id), 'Subscription deleted')) await subscriptions.reload();
  }

  return (
    <div className="stack">
      <h1>Events</h1>
      <p className="muted">
        MCP Events (<code>io.modelcontextprotocol/events</code>) served over the same endpoint as tools and resources.
      </p>

      <Card title="Event types" description="What subscribers can listen for.">
        <LoadState resource={types} label="event types" />
        <DataTable
          caption="Event types"
          empty="No event types are advertised."
          rows={types.data ?? []}
          rowKey={(t) => t.name}
          columns={[
            { header: 'Name', rowHeader: true, cell: (t) => <code>{t.name}</code> },
            { header: 'Source', cell: (t) => t.sourceId },
            { header: 'Description', cell: (t) => t.description },
            { header: 'Delivery', cell: (t) => <span className="row wrap">{t.supportedModes.map((m) => <Pill key={m} tone="info">{m}</Pill>)}</span> },
            {
              header: 'Schemas',
              cell: (t) => (
                <details>
                  <summary>Payload schema</summary>
                  <CodeBlock text={json({ input: t.inputSchema, payload: t.payloadSchema })} label={`${t.name} schemas`} />
                </details>
              ),
            },
          ]}
        />
      </Card>

      <Card title="Active subscriptions" description="Clients currently subscribed through the gateway.">
        <LoadState resource={subscriptions} label="subscriptions" />
        <DataTable
          caption="Event subscriptions"
          empty="No active subscriptions."
          rows={subscriptions.data ?? []}
          rowKey={(s) => s.id}
          columns={[
            { header: 'Event', rowHeader: true, cell: (s) => <code>{s.name}</code> },
            { header: 'Profile', cell: (s) => s.profileId },
            { header: 'Mode', cell: (s) => <Pill tone="info">{s.mode}</Pill> },
            { header: 'Cursor', cell: (s) => s.cursor ?? '—' },
            { header: 'Expires', cell: (s) => formatTime(s.expiresAt) },
            {
              header: 'Actions',
              cell: (s) => (
                <Button data-size="sm" data-variant="destructive" onClick={() => removeSubscription(s.id)} aria-label={`Delete subscription ${s.name}`}>
                  <TrashIcon aria-hidden="true" /> Delete
                </Button>
              ),
            },
          ]}
        />
      </Card>

      <Card
        title="Occurrence log"
        description="Newest first. Cursors let subscribers resume where they left off."
        actions={<SwitchField label="Auto-refresh" checked={live} onChange={setLive} />}
      >
        <SelectField label="Event" value={name} onChange={setName} options={[{ value: ALL, label: 'All events' }, ...typeOptions]} />
        <LoadState resource={occurrences} label="occurrences" />
        <DataTable
          caption="Event occurrences"
          empty="No occurrences yet. Use Test emit below."
          rows={rows}
          rowKey={(o) => o.eventId}
          columns={[
            { header: 'Cursor', rowHeader: true, cell: (o) => <code>{o.cursor}</code> },
            { header: 'Event', cell: (o) => <code>{o.name}</code> },
            { header: 'Source', cell: (o) => o.sourceId },
            { header: 'Time', cell: (o) => formatTime(o.timestamp) },
            { header: 'Data', cell: (o) => <details><summary>View</summary><pre className="inline-pre">{json(o.data)}</pre></details> },
          ]}
        />
      </Card>

      <EmitCard typeNames={typeOptions.map((t) => t.value)} onEmitted={() => void occurrences.reload()} />
    </div>
  );
}

function EmitCard({ typeNames, onEmitted }: { typeNames: string[]; onEmitted: (o: McpEventOccurrence) => void }) {
  const [name, setName] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [data, setData] = useState('{\n  \n}');
  const [error, setError] = useState<string>();
  const [last, setLast] = useState<McpEventOccurrence>();
  const [busy, setBusy] = useState(false);

  async function emit(event: React.FormEvent) {
    event.preventDefault();
    setError(undefined);
    setBusy(true);
    try {
      const occurrence = await api.emitEvent({
        name: name.trim(),
        ...(sourceId.trim() ? { sourceId: sourceId.trim() } : {}),
        data: parseJsonObject(data.trim() || '{}', 'Event data'),
      });
      setLast(occurrence);
      notify.success('Event emitted', `${occurrence.name} at cursor ${occurrence.cursor}`);
      onEmitted(occurrence);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Test emit" description="Emit an event into the gateway to verify subscribers receive it.">
      <form className="stack" onSubmit={emit}>
        <div className="form-row">
          {typeNames.length > 0 ? (
            <SelectField label="Known event type" value={typeNames.includes(name) ? name : ''} onChange={setName} options={typeNames.map((t) => ({ value: t, label: t }))} placeholder="Pick a type…" />
          ) : null}
          <TextField label="Event name (required)" value={name} onChange={setName} required mono />
        </div>
        <TextField label="Source ID (optional)" value={sourceId} onChange={setSourceId} />
        <TextAreaField label="Data (JSON object)" value={data} onChange={setData} rows={5} mono />
        {error ? <Notice tone="error">{error}</Notice> : null}
        {last ? <Notice tone="ok">Emitted <code>{last.name}</code> as event {last.eventId}, cursor <code>{last.cursor}</code>.</Notice> : null}
        <div className="row end">
          <Button type="submit" data-variant="solid" disabled={busy || !name.trim()}>
            <SendIcon aria-hidden="true" /> {busy ? 'Emitting…' : 'Emit event'}
          </Button>
        </div>
      </form>
    </Card>
  );
}
