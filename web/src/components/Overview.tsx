import { useState } from 'react';
import { Tabs, TabsList, TabsPanel, TabsTab } from '@ui-sdk/react/tabs';
import { AlertTriangleIcon, KeyRoundIcon, ShieldAlertIcon } from 'lucide-react';
import { api } from '../api';
import { useApprovals } from './approvals';
import {
  Button,
  Card,
  CodeBlock,
  CopyButton,
  HealthPill,
  LoadState,
  Notice,
  Pill,
  SelectField,
  Stat,
  attempt,
  formatUptime,
  useResource,
} from './ui';

export function Overview({ onNavigate }: { onNavigate: (view: string) => void }) {
  const status = useResource(() => api.status(), [], { intervalMs: 15_000 });
  const sources = useResource(() => api.sources(), [], { intervalMs: 15_000 });
  const { pending } = useApprovals();
  const s = status.data;

  return (
    <div className="stack">
      <h1>Overview</h1>
      <LoadState resource={status} label="gateway status" />

      {pending.length > 0 ? (
        <Notice tone="warn" title={`${pending.length} approval${pending.length === 1 ? '' : 's'} waiting`}>
          An agent is blocked until you decide.{' '}
          <Button data-variant="solid" data-size="sm" onClick={() => onNavigate('safety')}>
            <ShieldAlertIcon aria-hidden="true" /> Review approvals
          </Button>
        </Notice>
      ) : null}
      {s && s.counts.pendingProposals > 0 ? (
        <Notice tone="info" title={`${s.counts.pendingProposals} capability proposal${s.counts.pendingProposals === 1 ? '' : 's'} to review`}>
          Agent-drafted tools stay inactive until you activate them.{' '}
          <Button data-size="sm" onClick={() => onNavigate('safety')}>
            Inspect proposals
          </Button>
        </Notice>
      ) : null}

      {s ? (
        <Card
          title="Gateway"
          description="One persistent pool behind one endpoint."
          actions={<Pill tone={s.mode === 'local' ? 'info' : 'ok'}>{s.mode} mode</Pill>}
        >
          <dl className="stats">
            <Stat
              label="Sources healthy"
              value={`${s.counts.healthySources} / ${s.counts.sources}`}
              hint={s.counts.degradedSources ? `${s.counts.degradedSources} need attention` : 'all clear'}
            />
            <Stat label="Capabilities" value={s.counts.capabilities} />
            <Stat label="Profiles" value={s.counts.profiles} />
            <Stat label="Active tokens" value={s.counts.activeTokens} />
            <Stat label="Event subscriptions" value={s.counts.activeEventSubscriptions} />
            <Stat label="Uptime" value={formatUptime(s.uptimeSeconds)} hint={`v${s.version}`} />
          </dl>
          <p className="muted">
            Public URL <code>{s.publicUrl}</code>
            {s.homeDir ? (
              <>
                {' '}
                · Home <code>{s.homeDir}</code>
              </>
            ) : null}
          </p>
        </Card>
      ) : null}

      <ConnectCard />

      <Card title="Source health" description="A broken upstream only degrades its own capabilities.">
        <LoadState resource={sources} label="sources" />
        {sources.data && sources.data.length === 0 ? (
          <p className="empty">
            No sources yet.{' '}
            <Button data-variant="solid" data-size="sm" onClick={() => onNavigate('sources')}>
              Add your first source
            </Button>
          </p>
        ) : (
          <ul className="health-list">
            {sources.data?.map((source) => (
              <li key={source.id}>
                <span>{source.name}</span>
                <HealthPill health={source.health} />
                {source.lastError ? <small className="muted">{source.lastError}</small> : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function ConnectCard() {
  const profiles = useResource(() => api.profiles(), []);
  const [profileId, setProfileId] = useState('');
  const selected = profileId || profiles.data?.[0]?.id || '';
  const snippets = useResource(
    () => (selected ? api.connectSnippets(selected) : Promise.resolve(undefined)),
    [selected],
  );
  const [minted, setMinted] = useState<{ token: string; profileId: string }>();
  const data = snippets.data;
  const token = minted && minted.profileId === selected ? minted.token : undefined;
  const fill = (text: string) => (token && data ? text.replaceAll(data.tokenPlaceholder, token) : text);

  async function mint() {
    const result = await attempt(
      () => api.createToken({ label: `connect-${new Date().toISOString().slice(0, 10)}`, profileId: selected }),
      'Token minted',
    );
    if (result) setMinted({ token: result.token, profileId: selected });
  }

  return (
    <Card
      title="Connect a harness"
      description="One URL and one token per profile. Paste the snippet into your harness; AgentFabric never writes into local agent folders."
    >
      <LoadState resource={profiles} label="profiles" />
      <div className="form-row">
        <SelectField
          label="Profile"
          value={selected}
          onChange={setProfileId}
          options={(profiles.data ?? []).map((p) => ({ value: p.id, label: p.name }))}
        />
        <div className="row end">
          <Button data-variant="solid" onClick={mint} disabled={!selected}>
            <KeyRoundIcon aria-hidden="true" /> Mint token
          </Button>
        </div>
      </div>

      {token ? (
        <Notice tone="ok" title="Token minted. It is shown only once.">
          <div className="row wrap">
            <code className="token">{token}</code>
            <CopyButton text={token} label="token" />
          </div>
          Snippets below now contain this token. For shared shells prefer the environment variable form.
        </Notice>
      ) : null}

      <LoadState resource={snippets} label="connection snippets" />
      {data ? (
        <>
          <div className="row wrap url-row">
            <span className="muted">MCP URL</span>
            <code>{data.mcpUrl}</code>
            <CopyButton text={data.mcpUrl} label="MCP URL" />
          </div>
          <p className="muted">
            One endpoint serves tools, prompts, resources, skills (<code>skill://</code> via{' '}
            <code>ext/skills</code>) and events (<code>io.modelcontextprotocol/events</code>). Local writes:{' '}
            <strong>{data.localWrites}</strong>. No files or symlinks are created in harness folders.
          </p>
          {data.warnings.map((warning) => (
            <Notice key={warning} tone="warn">
              <AlertTriangleIcon aria-hidden="true" className="inline-icon" /> {warning}
            </Notice>
          ))}
          <Tabs defaultValue={data.snippets[0]?.id}>
            <TabsList aria-label="Harness" className="subtabs">
              {data.snippets.map((snippet) => (
                <TabsTab key={snippet.id} value={snippet.id}>
                  {snippet.label}
                </TabsTab>
              ))}
            </TabsList>
            {data.snippets.map((snippet) => (
              <TabsPanel key={snippet.id} value={snippet.id}>
                <div className="stack tight">
                  <p>
                    {snippet.description} <Pill tone="info">{snippet.auth === 'oauth' ? 'OAuth 2.1 + PKCE' : 'Bearer token'}</Pill>
                  </p>
                  <p className="muted">{snippet.target}</p>
                  <CodeBlock text={fill(snippet.content)} label={`${snippet.label} snippet`} />
                </div>
              </TabsPanel>
            ))}
          </Tabs>
        </>
      ) : null}
    </Card>
  );
}
