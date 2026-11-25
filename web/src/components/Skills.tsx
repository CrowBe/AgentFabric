import { useMemo, useState } from 'react';
import {
  ScrollArea,
  ScrollAreaContent,
  ScrollAreaScrollbar,
  ScrollAreaThumb,
  ScrollAreaViewport,
} from '@ui-sdk/react/scroll-area';
import { EyeIcon, FolderIcon, GitBranchIcon, PencilIcon, PlusIcon, RefreshCwIcon, TrashIcon } from 'lucide-react';
import type {
  SharedFolderSourceConfig,
  SkillRepoSourceConfig,
  SkillSourceConfig,
} from '../../../src/types/index.js';
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
  formatRelative,
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

function SkillContentPreview({ capId, title }: { capId: string; title: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [loaded, setLoaded] = useState<{
    uri: string;
    content: string;
    files?: Record<string, string>;
  }>();

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !loaded && !loading) {
      setLoading(true);
      setError(undefined);
      try {
        setLoaded(await api.capabilityContent(capId));
      } catch (caught) {
        setError(describeError(caught));
      } finally {
        setLoading(false);
      }
    }
  }

  return (
    <div className="skill-preview-wrap">
      <Button
        type="button"
        data-size="sm"
        onClick={() => void toggle()}
        aria-expanded={open}
        aria-label={open ? `Hide ${title} SKILL.md` : `Preview ${title} SKILL.md`}
      >
        <EyeIcon aria-hidden="true" /> {open ? 'Hide SKILL.md' : 'Preview SKILL.md'}
      </Button>
      {open ? (
        <div className="stack tight">
          {loading ? <p className="muted">Loading content…</p> : null}
          {error ? <Notice tone="error">{error}</Notice> : null}
          {loaded ? (
            <>
              <ScrollArea className="preview">
                <ScrollAreaViewport role="region" aria-label={`${title} SKILL.md`} tabIndex={0}>
                  <ScrollAreaContent>
                    <pre>{loaded.content}</pre>
                  </ScrollAreaContent>
                </ScrollAreaViewport>
                <ScrollAreaScrollbar orientation="vertical">
                  <ScrollAreaThumb />
                </ScrollAreaScrollbar>
              </ScrollArea>
              {loaded.files && Object.keys(loaded.files).length > 0 ? (
                <details>
                  <summary>Attached files ({Object.keys(loaded.files).length})</summary>
                  <ul className="plain">
                    {Object.entries(loaded.files).map(([fileName, body]) => (
                      <li key={fileName}>
                        <details>
                          <summary>
                            <code>{fileName}</code>
                          </summary>
                          <ScrollArea className="preview">
                            <ScrollAreaViewport role="region" aria-label={fileName} tabIndex={0}>
                              <ScrollAreaContent>
                                <pre>{body}</pre>
                              </ScrollAreaContent>
                            </ScrollAreaViewport>
                            <ScrollAreaScrollbar orientation="vertical">
                              <ScrollAreaThumb />
                            </ScrollAreaScrollbar>
                          </ScrollArea>
                        </details>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function SkillRepoCard({
  source,
  caps,
  onRefresh,
  onToggle,
  onDelete,
}: {
  source: SourceRecord;
  caps: EffectiveCapability[];
  onRefresh: (source: SourceRecord) => Promise<void>;
  onToggle: (source: SourceRecord, enabled: boolean) => Promise<void>;
  onDelete: (source: SourceRecord) => Promise<void>;
}) {
  const config = source.config as SkillRepoSourceConfig;
  const skillCaps = useMemo(() => caps.filter((cap) => cap.kind === 'skill'), [caps]);
  const [filter, setFilter] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const visibleSkills = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return skillCaps;
    return skillCaps.filter(
      (cap) =>
        cap.exposedName.toLowerCase().includes(q) ||
        cap.description.toLowerCase().includes(q) ||
        cap.tags.some((tag) => tag.toLowerCase().includes(q)),
    );
  }, [skillCaps, filter]);

  async function refreshClick() {
    setRefreshing(true);
    try {
      await onRefresh(source);
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <article className="mini-card skill-repo-card" aria-label={`Skill repo ${source.name}`}>
      <header className="row wrap">
        <h3>{source.name}</h3>
        <div className="row wrap">
          <Pill tone="info">GitHub</Pill>
          <Pill tone="muted">
            {skillCaps.length} {skillCaps.length === 1 ? 'skill' : 'skills'}
          </Pill>
          <HealthPill health={source.health} />
        </div>
      </header>
      <p className="url-row">
        <a href={config.url} target="_blank" rel="noopener noreferrer" className="mono">
          {config.url}
        </a>
        {config.ref ? (
          <>
            {' '}
            · ref <code>{config.ref}</code>
          </>
        ) : null}
        {config.path ? (
          <>
            {' '}
            · path <code>{config.path}</code>
          </>
        ) : null}
        {source.lastRefreshedAt ? <> · synced {formatRelative(source.lastRefreshedAt)}</> : null}
      </p>
      {source.lastError ? <Notice tone="warn">{source.lastError}</Notice> : null}
      {(config.tags ?? []).length > 0 ? (
        <p className="row wrap">
          {(config.tags ?? []).map((tag) => (
            <Pill key={tag} tone="info">
              {tag}
            </Pill>
          ))}
        </p>
      ) : null}
      <details>
        <summary>Browse skills ({skillCaps.length})</summary>
        <div className="stack tight">
          {skillCaps.length > 5 ? (
            <TextField
              label={`Filter ${source.name} skills`}
              value={filter}
              onChange={setFilter}
              placeholder="Search slug, description, tag…"
            />
          ) : null}
          {visibleSkills.length === 0 ? (
            <p className="empty">No matching skills.</p>
          ) : (
            <ul className="plain skill-list">
              {visibleSkills.map((cap) => (
                <li key={cap.id} className="skill-item">
                  <div className="row wrap">
                    <strong>{cap.exposedName}</strong>
                    <code>{cap.uri ?? `skill://${cap.originalName}`}</code>
                  </div>
                  {cap.description ? <p className="muted">{cap.description}</p> : null}
                  <SkillContentPreview capId={cap.id} title={cap.exposedName} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </details>
      <footer className="row wrap">
        <SwitchField label="Enabled" checked={source.enabled} onChange={(next) => void onToggle(source, next)} />
        <Button data-size="sm" disabled={refreshing} onClick={() => void refreshClick()} aria-label={`Refresh ${source.name}`}>
          <RefreshCwIcon aria-hidden="true" /> {refreshing ? 'Refreshing…' : 'Refresh'}
        </Button>
        <Button data-size="sm" data-variant="destructive" onClick={() => void onDelete(source)} aria-label={`Delete ${source.name}`}>
          <TrashIcon aria-hidden="true" /> Delete
        </Button>
      </footer>
    </article>
  );
}

export function Skills() {
  const status = useResource(() => api.status(), []);
  const sources = useResource(() => api.sources(), []);
  const pool = useResource(() => api.capabilities(), []);
  const [adding, setAdding] = useState<AddSourceInitial>();
  const [editing, setEditing] = useState<SourceRecord>();

  const [ghUrl, setGhUrl] = useState('');
  const [ghName, setGhName] = useState('');
  const [ghRef, setGhRef] = useState('');
  const [ghPath, setGhPath] = useState('');
  const [ghInclude, setGhInclude] = useState('');
  const [ghTags, setGhTags] = useState('');
  const [ghSecret, setGhSecret] = useState('');
  const [ghBusy, setGhBusy] = useState(false);
  const [ghError, setGhError] = useState<string>();

  const repoSources = (sources.data ?? []).filter((s) => s.kind === 'skill_repo');
  const skills = (sources.data ?? []).filter((s) => s.kind === 'skill');
  const folders = (sources.data ?? []).filter((s) => s.kind === 'shared_folder');
  const bySource = useMemo(() => {
    const map = new Map<string, EffectiveCapability[]>();
    for (const cap of pool.data ?? []) map.set(cap.sourceId, [...(map.get(cap.sourceId) ?? []), cap]);
    return map;
  }, [pool.data]);
  const remote = status.data?.mode === 'remote';
  const reload = () => Promise.all([sources.reload(), pool.reload()]);

  async function importGitHub(event: React.FormEvent) {
    event.preventDefault();
    if (!ghUrl.trim()) return;
    setGhBusy(true);
    setGhError(undefined);
    try {
      const created = await api.instantiateRecipe('github-skill-repo', {
        url: ghUrl.trim(),
        ...(ghName.trim() ? { name: ghName.trim() } : {}),
        ...(ghRef.trim() ? { ref: ghRef.trim() } : {}),
        ...(ghPath.trim() ? { path: ghPath.trim() } : {}),
        ...(ghInclude.trim() ? { includeSkills: lines(ghInclude) } : {}),
        ...(ghTags.trim() ? { tags: lines(ghTags) } : {}),
        ...(ghSecret.trim() ? { secretName: ghSecret.trim() } : {}),
      });
      const importedCaps = await api.capabilities({ sourceId: created.id, kind: 'skill' });
      notify.success('Imported skills', `${created.name} · ${importedCaps.length} skill(s)`);
      setGhUrl('');
      setGhName('');
      setGhRef('');
      setGhPath('');
      setGhInclude('');
      setGhTags('');
      setGhSecret('');
      await reload();
    } catch (caught) {
      setGhError(describeError(caught));
    } finally {
      setGhBusy(false);
    }
  }

  async function refreshRepo(source: SourceRecord) {
    if (await attempt(() => api.refreshSource(source.id), `Refreshed ${source.name}`)) await reload();
  }
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
            Reusable skills served over MCP as <code>skill://</code> resources (<code>io.modelcontextprotocol/skills</code>). Paste any
            GitHub skill URL or let connected agents propose additions behind Safety approvals.
          </>
        }
        actions={
          <Button onClick={() => setAdding({ tab: 'recipe', recipeId: 'agent-skill' })}>
            <PlusIcon aria-hidden="true" /> Add custom skill
          </Button>
        }
      >
        <form className="github-import" onSubmit={importGitHub}>
          <div className="github-import-bar">
            <TextField
              label="Import from GitHub URL"
              value={ghUrl}
              onChange={setGhUrl}
              placeholder="https://github.com/owner/repo or owner/repo"
              description="Supports repo URLs, /tree/<branch>/<subpath>, or direct /blob/.../SKILL.md links."
              mono
              required
            />
            <Button type="submit" data-variant="solid" disabled={ghBusy || !ghUrl.trim()}>
              <GitBranchIcon aria-hidden="true" /> {ghBusy ? 'Importing…' : 'Import'}
            </Button>
          </div>
          <details className="github-options">
            <summary>Optional filters &amp; private repo auth</summary>
            <div className="form-row">
              <TextField label="Source name" value={ghName} onChange={setGhName} placeholder="auto-detected" />
              <TextField label="Branch, tag, or commit" value={ghRef} onChange={setGhRef} placeholder="HEAD" mono />
              <TextField label="Subpath in repo" value={ghPath} onChange={setGhPath} placeholder="skills/vision" mono />
            </div>
            <div className="form-row">
              <TextField label="Only include slugs (comma separated)" value={ghInclude} onChange={setGhInclude} placeholder="vision, poteto-mode" mono />
              <TextField label="Tags (comma separated)" value={ghTags} onChange={setGhTags} />
              <TextField label="GitHub token secret name" value={ghSecret} onChange={setGhSecret} placeholder="github_pat" mono />
            </div>
          </details>
          {ghError ? <Notice tone="error" title="GitHub import failed">{ghError}</Notice> : null}
        </form>

        {repoSources.length === 0 && skills.length === 0 ? <p className="empty">No skills yet.</p> : null}

        {repoSources.length > 0 ? (
          <div className="stack">
            {repoSources.map((source) => (
              <SkillRepoCard
                key={source.id}
                source={source}
                caps={bySource.get(source.id) ?? []}
                onRefresh={refreshRepo}
                onToggle={toggle}
                onDelete={remove}
              />
            ))}
          </div>
        ) : null}

        {skills.length > 0 ? (
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
        ) : null}
      </Card>

      <Card
        title="Shared folders"
        description={
          <>
            Bounded folders exposed as <code>workspace://</code> resources. The gateway never reaches outside the root.
          </>
        }
        actions={
          <Button data-variant="solid" onClick={() => setAdding({ tab: 'recipe', recipeId: 'shared-workspace-folder' })}>
            <FolderIcon aria-hidden="true" /> Share a folder
          </Button>
        }
      >
        {remote ? (
          <Notice tone="info">
            This gateway runs in remote mode. Local CLI wrappers and stdio processes are blocked, while explicit server-side shared folders stay available.
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
                    <Pill tone="ok">read-only</Pill>
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
            readOnly: true,
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
      <p className="muted">Shared folders are always read-only. Agents can list and read files inside the root but never write.</p>
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
