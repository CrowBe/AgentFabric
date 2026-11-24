import { useMemo, useState } from 'react';
import {
  ScrollArea,
  ScrollAreaContent,
  ScrollAreaScrollbar,
  ScrollAreaThumb,
  ScrollAreaViewport,
} from '@ui-sdk/react/scroll-area';
import { FolderIcon, PencilIcon, PlusIcon, TrashIcon } from 'lucide-react';
import type { SharedFolderSourceConfig, SkillSourceConfig } from '../../../src/types/index.js';
import { api, describeError, type EffectiveCapability, type SourceRecord } from '../api';
import { AddSourceDialog, type AddSourceInitial } from './AddSourceDialog';
import {
  Button,
  Card,
  HealthPill,
  LoadState,
  Modal,
  Notice,
  Pill,
  SwitchField,
  TextAreaField,
  TextField,
  ask,
  attempt,
  lines,
  notify,
  useResource,
} from './ui';

function CapabilityList({ caps }: { caps: EffectiveCapability[] }) {
  if (caps.length === 0) return <p className="muted">No capabilities published yet. Refresh the source.</p>;
  return (
    <ul className="plain">
      {caps.map((cap) => (
        <li key={cap.id}>
          <code>{cap.exposedName}</code> <Pill tone="muted">{cap.kind}</Pill> {cap.uri ? <code>{cap.uri}</code> : null}
        </li>
      ))}
    </ul>
  );
}

export function Skills() {
  const status = useResource(() => api.status(), []);
  const sources = useResource(() => api.sources(), []);
  const pool = useResource(() => api.capabilities(), []);
  const [adding, setAdding] = useState<AddSourceInitial>();
  const [editing, setEditing] = useState<SourceRecord>();

  const skills = (sources.data ?? []).filter((s) => s.kind === 'skill');
  const folders = (sources.data ?? []).filter((s) => s.kind === 'shared_folder');
  const bySource = useMemo(() => {
    const map = new Map<string, EffectiveCapability[]>();
    for (const cap of pool.data ?? []) map.set(cap.sourceId, [...(map.get(cap.sourceId) ?? []), cap]);
    return map;
  }, [pool.data]);
  const remote = status.data?.mode === 'remote';
  const reload = () => Promise.all([sources.reload(), pool.reload()]);

  async function remove(source: SourceRecord) {
    if (!(await ask(`Delete ${source.name}?`, 'It stops being served to every connected harness.', 'Delete'))) return;
    if (await attempt(() => api.deleteSource(source.id), `Deleted ${source.name}`)) await reload();
  }
  async function toggle(source: SourceRecord, enabled: boolean) {
    if (await attempt(() => api.updateSource(source.id, { enabled }))) await reload();
  }

  return (
    <div className="stack">
      <h1>Skills &amp; Shared Folders</h1>
      <LoadState resource={sources} label="skills and folders" />

      <Card
        title="Agent skills"
        description={
          <>
            Reusable skills served over MCP as <code>skill://</code> resources (<code>ext/skills</code>). Every harness gets them
            from the gateway; nothing is written into local skill folders.
          </>
        }
        actions={
          <Button data-variant="solid" onClick={() => setAdding({ tab: 'recipe', recipeId: 'agent-skill' })}>
            <PlusIcon aria-hidden="true" /> Add skill
          </Button>
        }
      >
        {skills.length === 0 ? <p className="empty">No skills yet.</p> : null}
        <div className="grid">
          {skills.map((source) => {
            const config = source.config as SkillSourceConfig;
            return (
              <article key={source.id} className="mini-card" aria-label={`Skill ${config.title}`}>
                <header>
                  <h3>{config.title}</h3>
                  <HealthPill health={source.health} />
                </header>
                <p>{config.description}</p>
                <p className="muted">
                  <code>skill://{config.slug}</code>
                </p>
                <p className="row wrap">
                  {(config.tags ?? []).map((tag) => (
                    <Pill key={tag} tone="info">
                      {tag}
                    </Pill>
                  ))}
                </p>
                <details>
                  <summary>Preview content</summary>
                  <ScrollArea className="preview">
                    <ScrollAreaViewport role="region" aria-label={`${config.title} content`} tabIndex={0}>
                      <ScrollAreaContent>
                        <pre>{config.content}</pre>
                      </ScrollAreaContent>
                    </ScrollAreaViewport>
                    <ScrollAreaScrollbar orientation="vertical">
                      <ScrollAreaThumb />
                    </ScrollAreaScrollbar>
                  </ScrollArea>
                </details>
                <details>
                  <summary>What agents see</summary>
                  <CapabilityList caps={bySource.get(source.id) ?? []} />
                </details>
                <footer className="row wrap">
                  <SwitchField label="Enabled" checked={source.enabled} onChange={(next) => void toggle(source, next)} />
                  <Button data-size="sm" onClick={() => setEditing(source)} aria-label={`Edit ${config.title}`}>
                    <PencilIcon aria-hidden="true" /> Edit
                  </Button>
                  <Button data-size="sm" data-variant="destructive" onClick={() => remove(source)} aria-label={`Delete ${config.title}`}>
                    <TrashIcon aria-hidden="true" /> Delete
                  </Button>
                </footer>
              </article>
            );
          })}
        </div>
      </Card>

      <Card
        title="Shared folders"
        description={
          <>
            Bounded folders exposed as <code>workspace://</code> resources. The gateway never reaches outside the root.
          </>
        }
        actions={
          <Button data-variant="solid" disabled={remote} onClick={() => setAdding({ tab: 'recipe', recipeId: 'shared-workspace-folder' })}>
            <FolderIcon aria-hidden="true" /> Share a folder
          </Button>
        }
      >
        {remote ? (
          <Notice tone="warn">
            This gateway runs in remote mode and never tunnels back into your local disk. Use explicit server-to-client sharing for
            local workspace context.
          </Notice>
        ) : null}
        {folders.length === 0 ? <p className="empty">No folders shared.</p> : null}
        <div className="grid">
          {folders.map((source) => {
            const config = source.config as SharedFolderSourceConfig;
            return (
              <article key={source.id} className="mini-card" aria-label={`Folder ${config.shareName}`}>
                <header>
                  <h3>{config.shareName}</h3>
                  <HealthPill health={source.health} />
                </header>
                {config.description ? <p>{config.description}</p> : null}
                <dl className="kv">
                  <dt>URI</dt>
                  <dd>
                    <code>workspace://{config.shareName}/</code>
                  </dd>
                  <dt>Root</dt>
                  <dd>
                    <code>{config.rootPath}</code>
                  </dd>
                  <dt>Access</dt>
                  <dd>
                    <Pill tone={config.readOnly ? 'ok' : 'warn'}>{config.readOnly ? 'read-only' : 'read & write'}</Pill>
                  </dd>
                  <dt>Limits</dt>
                  <dd>
                    {config.maxFileBytes ? `${config.maxFileBytes.toLocaleString()} bytes/file` : 'default size'}
                    {config.allowedExtensions?.length ? ` · ${config.allowedExtensions.join(', ')}` : ' · any extension'}
                  </dd>
                </dl>
                <details>
                  <summary>What agents see</summary>
                  <CapabilityList caps={bySource.get(source.id) ?? []} />
                </details>
                <footer className="row wrap">
                  <SwitchField label="Enabled" checked={source.enabled} onChange={(next) => void toggle(source, next)} />
                  <Button data-size="sm" onClick={() => setEditing(source)} aria-label={`Edit ${config.shareName}`}>
                    <PencilIcon aria-hidden="true" /> Edit
                  </Button>
                  <Button data-size="sm" data-variant="destructive" onClick={() => remove(source)} aria-label={`Stop sharing ${config.shareName}`}>
                    <TrashIcon aria-hidden="true" /> Remove
                  </Button>
                </footer>
              </article>
            );
          })}
        </div>
      </Card>

      <AddSourceDialog
        open={adding !== undefined}
        initial={adding}
        onClose={() => setAdding(undefined)}
        onCreated={() => void reload()}
        mode={status.data?.mode ?? 'local'}
      />
      <EditDialog source={editing} onClose={() => setEditing(undefined)} onSaved={() => void reload()} />
    </div>
  );
}

function EditDialog({
  source,
  onClose,
  onSaved,
}: {
  source: SourceRecord | undefined;
  onClose: () => void;
  onSaved: () => void;
}) {
  return (
    <Modal
      open={source !== undefined}
      onClose={onClose}
      wide
      title={source?.kind === 'skill' ? 'Edit skill' : 'Edit shared folder'}
      description="Changes apply to every connected harness immediately."
    >
      {source?.kind === 'skill' ? (
        <SkillForm key={source.id} source={source} onClose={onClose} onSaved={onSaved} />
      ) : source?.kind === 'shared_folder' ? (
        <FolderForm key={source.id} source={source} onClose={onClose} onSaved={onSaved} />
      ) : null}
    </Modal>
  );
}

function useSaver(source: SourceRecord, onClose: () => void, onSaved: () => void) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function save(build: () => SkillSourceConfig | SharedFolderSourceConfig) {
    setBusy(true);
    setError(undefined);
    try {
      await api.updateSource(source.id, { config: build() });
      notify.success('Saved', source.name);
      onSaved();
      onClose();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  }
  return { error, busy, save };
}

function SkillForm({ source, onClose, onSaved }: { source: SourceRecord; onClose: () => void; onSaved: () => void }) {
  const config = source.config as SkillSourceConfig;
  const [title, setTitle] = useState(config.title);
  const [description, setDescription] = useState(config.description);
  const [content, setContent] = useState(config.content);
  const [tags, setTags] = useState((config.tags ?? []).join(', '));
  const { error, busy, save } = useSaver(source, onClose, onSaved);
  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        void save(() => ({ ...config, title, description, content, tags: lines(tags) }));
      }}
    >
      <TextField label="Title (required)" value={title} onChange={setTitle} required />
      <TextAreaField label="When to use it" value={description} onChange={setDescription} rows={3} required />
      <TextAreaField label="Content (markdown)" value={content} onChange={setContent} rows={12} mono required />
      <TextField label="Tags (comma separated)" value={tags} onChange={setTags} />
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className="row end">
        <Button type="button" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" data-variant="solid" disabled={busy}>
          {busy ? 'Saving…' : 'Save skill'}
        </Button>
      </div>
    </form>
  );
}

function FolderForm({ source, onClose, onSaved }: { source: SourceRecord; onClose: () => void; onSaved: () => void }) {
  const config = source.config as SharedFolderSourceConfig;
  const [description, setDescription] = useState(config.description ?? '');
  const [readOnly, setReadOnly] = useState(config.readOnly);
  const [maxFileBytes, setMaxFileBytes] = useState(String(config.maxFileBytes ?? ''));
  const [extensions, setExtensions] = useState((config.allowedExtensions ?? []).join(', '));
  const { error, busy, save } = useSaver(source, onClose, onSaved);
  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        void save(() => {
          const { description: _d, maxFileBytes: _m, allowedExtensions: _a, ...rest } = config;
          const bytes = Number(maxFileBytes);
          const allowed = lines(extensions);
          return {
            ...rest,
            readOnly,
            ...(description.trim() ? { description: description.trim() } : {}),
            ...(maxFileBytes && Number.isFinite(bytes) && bytes > 0 ? { maxFileBytes: Math.floor(bytes) } : {}),
            ...(allowed.length ? { allowedExtensions: allowed } : {}),
          };
        });
      }}
    >
      <p className="muted">
        Root <code>{config.rootPath}</code> cannot be changed here. Remove and re-share to move it.
      </p>
      <TextField label="Description" value={description} onChange={setDescription} />
      <SwitchField
        label="Read-only"
        checked={readOnly}
        onChange={setReadOnly}
        description="Turning this off lets agents write inside the root."
      />
      <TextField label="Max file size (bytes)" value={maxFileBytes} onChange={setMaxFileBytes} type="number" />
      <TextField label="Allowed extensions (comma separated)" value={extensions} onChange={setExtensions} placeholder=".md, .txt" />
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className="row end">
        <Button type="button" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" data-variant="solid" disabled={busy}>
          {busy ? 'Saving…' : 'Save folder'}
        </Button>
      </div>
    </form>
  );
}
