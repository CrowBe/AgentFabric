import { useState } from 'react';
import { KeyRoundIcon, LockIcon, TrashIcon } from 'lucide-react';
import { api, describeError } from '../api';
import {
  Button,
  Card,
  CopyButton,
  DataTable,
  LoadState,
  Notice,
  Pill,
  SelectField,
  TextField,
  ask,
  attempt,
  formatRelative,
  formatTime,
  lines,
  notify,
  useResource,
} from './ui';

export function AuthSecrets() {
  return (
    <div className="stack">
      <h1>Auth &amp; Secrets</h1>
      <Tokens />
      <OAuthClients />
      <Vault />
    </div>
  );
}

function Tokens() {
  const tokens = useResource(() => api.tokens(), []);
  const profiles = useResource(() => api.profiles(), []);
  const [label, setLabel] = useState('');
  const [profileId, setProfileId] = useState('');
  const [scopes, setScopes] = useState('mcp');
  const [minted, setMinted] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const selected = profileId || profiles.data?.[0]?.id || '';

  async function mint(event: React.FormEvent) {
    event.preventDefault();
    setError(undefined);
    setBusy(true);
    try {
      const result = await api.createToken({ label: label.trim(), profileId: selected, scopes: lines(scopes) });
      setMinted(result.token);
      setLabel('');
      notify.success('Token minted');
      await tokens.reload();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string, name: string) {
    const yes = await ask(`Revoke ${name}?`, 'Any harness using this token loses access immediately.', 'Revoke token');
    if (yes && (await attempt(() => api.revokeToken(id), 'Token revoked'))) await tokens.reload();
  }

  return (
    <Card title="Scoped bearer tokens" description="One token per harness and profile. Revoke any of them without touching the others.">
      <form className="stack" onSubmit={mint}>
        <div className="form-row">
          <TextField label="Label (required)" value={label} onChange={setLabel} required placeholder="cursor on laptop" />
          <SelectField label="Profile" value={selected} onChange={setProfileId} options={(profiles.data ?? []).map((p) => ({ value: p.id, label: p.name }))} />
          <TextField label="Scopes (comma separated)" value={scopes} onChange={setScopes} />
        </div>
        {error ? <Notice tone="error">{error}</Notice> : null}
        <div className="row">
          <Button type="submit" data-variant="solid" disabled={busy || !label.trim() || !selected}>
            <KeyRoundIcon aria-hidden="true" /> {busy ? 'Minting…' : 'Mint token'}
          </Button>
        </div>
      </form>
      {minted ? (
        <Notice tone="ok" title="Copy this token now. It is never shown again.">
          <div className="row wrap">
            <code className="token">{minted}</code>
            <CopyButton text={minted} label="new token" />
            <Button data-size="sm" onClick={() => setMinted(undefined)}>
              I have stored it
            </Button>
          </div>
        </Notice>
      ) : null}
      <LoadState resource={tokens} label="tokens" />
      <DataTable
        caption="Client tokens"
        empty="No tokens minted yet."
        rows={tokens.data ?? []}
        rowKey={(t) => t.id}
        columns={[
          { header: 'Label', rowHeader: true, cell: (t) => <strong>{t.label}</strong> },
          { header: 'Profile', cell: (t) => t.profileId },
          { header: 'Prefix', cell: (t) => <code>{t.tokenPrefix}…</code> },
          { header: 'Scopes', cell: (t) => t.scopes.join(', ') },
          { header: 'Created', cell: (t) => formatRelative(t.createdAt) },
          { header: 'Last used', cell: (t) => (t.lastUsedAt ? formatRelative(t.lastUsedAt) : 'never') },
          { header: 'State', cell: (t) => (t.revokedAt ? <Pill tone="bad">revoked</Pill> : <Pill tone="ok">active</Pill>) },
          {
            header: 'Actions',
            cell: (t) =>
              t.revokedAt ? (
                <span className="muted">—</span>
              ) : (
                <Button data-size="sm" data-variant="destructive" onClick={() => revoke(t.id, t.label)} aria-label={`Revoke ${t.label}`}>
                  Revoke
                </Button>
              ),
          },
        ]}
      />
    </Card>
  );
}

function OAuthClients() {
  const clients = useResource(() => api.oauthClients(), []);
  return (
    <Card title="OAuth clients" description="Harnesses that registered themselves (for example Claude on the web). You approve each one on the consent page.">
      <LoadState resource={clients} label="OAuth clients" />
      <DataTable
        caption="Registered OAuth clients"
        empty="No OAuth clients have registered yet."
        rows={clients.data ?? []}
        rowKey={(c) => c.clientId}
        columns={[
          { header: 'Client', rowHeader: true, cell: (c) => <><strong>{c.clientName}</strong><small className="muted block mono">{c.clientId}</small></> },
          { header: 'Redirect URIs', cell: (c) => c.redirectUris.map((u) => <code key={u} className="block">{u}</code>) },
          { header: 'Grants', cell: (c) => c.grantTypes.join(', ') },
          { header: 'Registered', cell: (c) => formatTime(c.createdAt) },
        ]}
      />
    </Card>
  );
}

function Vault() {
  const secrets = useResource(() => api.secrets(), []);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const exists = secrets.data?.some((s) => s.name === name.trim());

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError(undefined);
    if (exists && !(await ask(`Overwrite ${name.trim()}?`, 'The stored value is replaced and cannot be recovered.', 'Overwrite'))) return;
    setBusy(true);
    try {
      await api.setSecret(name.trim(), value, description.trim() || undefined);
      notify.success('Secret stored', name.trim());
      setName('');
      setValue('');
      setDescription('');
      await secrets.reload();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function remove(secretName: string) {
    const yes = await ask(`Delete ${secretName}?`, 'Sources that reference it will need credentials again.', 'Delete secret');
    if (yes && (await attempt(() => api.deleteSecret(secretName), 'Secret deleted'))) await secrets.reload();
  }

  return (
    <Card title="Secret vault" description="Write-only. Values are stored centrally, injected at call time, and can never be read back, even by you.">
      <form className="stack" onSubmit={save} autoComplete="off">
        <div className="form-row">
          <TextField label="Secret name (required)" value={name} onChange={setName} required mono placeholder="github_token" />
          <TextField label="Value (required)" value={value} onChange={setValue} type="password" required autoComplete="new-password" />
        </div>
        <TextField label="Description" value={description} onChange={setDescription} />
        {exists ? <Notice tone="warn">A secret named {name.trim()} exists. Saving replaces it.</Notice> : null}
        {error ? <Notice tone="error">{error}</Notice> : null}
        <div className="row">
          <Button type="submit" data-variant="solid" disabled={busy || !name.trim() || !value}>
            <LockIcon aria-hidden="true" /> {busy ? 'Storing…' : exists ? 'Replace secret' : 'Store secret'}
          </Button>
        </div>
      </form>
      <LoadState resource={secrets} label="secrets" />
      <DataTable
        caption="Stored secrets (names only)"
        empty="The vault is empty."
        rows={secrets.data ?? []}
        rowKey={(s) => s.name}
        columns={[
          { header: 'Name', rowHeader: true, cell: (s) => <code>{s.name}</code> },
          { header: 'Description', cell: (s) => s.description ?? '—' },
          { header: 'Updated', cell: (s) => formatTime(s.updatedAt) },
          { header: 'Value', cell: () => <span className="muted">write-only ••••••••</span> },
          {
            header: 'Actions',
            cell: (s) => (
              <Button data-size="sm" data-variant="destructive" onClick={() => remove(s.name)} aria-label={`Delete secret ${s.name}`}>
                <TrashIcon aria-hidden="true" /> Delete
              </Button>
            ),
          },
        ]}
      />
    </Card>
  );
}
