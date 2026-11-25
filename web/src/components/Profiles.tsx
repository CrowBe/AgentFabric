import { useEffect, useMemo, useState } from 'react';
import { Meter, MeterIndicator, MeterLabel, MeterTrack, MeterValue } from '@ui-sdk/react/meter';
import { PlusIcon, TrashIcon } from 'lucide-react';
import type { CapabilityKind, ExposureTier, ProfileRecord, ProfileRule, RulePermission } from '../../../src/types/index.js';
import { api, describeError } from '../api';
import {
  Button,
  Card,
  DataTable,
  LoadState,
  Modal,
  Notice,
  Pill,
  SelectField,
  TextAreaField,
  TextField,
  ask,
  attempt,
  notify,
  useResource,
} from './ui';

const ANY = '__any';

export function Profiles() {
  const profiles = useResource(() => api.profiles(), []);
  const [selectedId, setSelectedId] = useState('');
  const [creating, setCreating] = useState(false);
  const selected = profiles.data?.find((p) => p.id === selectedId) ?? profiles.data?.[0];

  return (
    <div className="stack">
      <h1>Profiles &amp; Discovery</h1>
      <Card
        title="Profiles"
        description="Scope visibility and permissions per harness, workspace, or task without fragmenting the pool."
        actions={
          <Button data-variant="solid" onClick={() => setCreating(true)}>
            <PlusIcon aria-hidden="true" /> New profile
          </Button>
        }
      >
        <LoadState resource={profiles} label="profiles" />
        <DataTable
          caption="Profiles"
          empty="No profiles."
          rows={profiles.data ?? []}
          rowKey={(p) => p.id}
          columns={[
            { header: 'Profile', rowHeader: true, cell: (p) => <strong>{p.name}</strong> },
            { header: 'Exposure', cell: (p) => <Pill tone={p.defaultExposure === 'direct' ? 'info' : 'ok'}>{p.defaultExposure}</Pill> },
            { header: 'Direct tool budget', cell: (p) => p.directToolBudget, align: 'end' },
            { header: 'Rules', cell: (p) => p.rules.length, align: 'end' },
            {
              header: 'Actions',
              cell: (p) => (
                <Button
                  data-size="sm"
                  data-variant={selected?.id === p.id ? 'solid' : undefined}
                  aria-pressed={selected?.id === p.id}
                  onClick={() => setSelectedId(p.id)}
                  aria-label={`Edit ${p.name}`}
                >
                  {selected?.id === p.id ? 'Editing' : 'Edit'}
                </Button>
              ),
            },
          ]}
        />
      </Card>

      {selected ? <ProfileEditor key={selected.id} profile={selected} onChanged={() => profiles.reload()} onDeleted={() => { setSelectedId(''); void profiles.reload(); }} /> : null}

      <CreateProfileDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(profile) => {
          setSelectedId(profile.id);
          void profiles.reload();
        }}
      />
    </div>
  );
}

function CreateProfileDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (profile: ProfileRecord) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [exposure, setExposure] = useState('direct');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setName('');
      setDescription('');
      setExposure('direct');
      setError(undefined);
    }
  }, [open]);
  return (
    <Modal open={open} onClose={onClose} title="New profile" description="A named scope for one harness, workspace, or task.">
      <form
        className="stack"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(undefined);
          try {
            const profile = await api.createProfile({
              name: name.trim(),
              description: description.trim(),
              defaultExposure: exposure as 'direct' | 'searchable',
            });
            notify.success('Profile created', profile.name);
            onCreated(profile);
            onClose();
          } catch (caught) {
            setError(describeError(caught));
          } finally {
            setBusy(false);
          }
        }}
      >
        <TextField label="Name (required)" value={name} onChange={setName} required description="Letters, digits, dash, underscore, dot. Used in the MCP URL." />
        <TextField label="Description" value={description} onChange={setDescription} />
        <SelectField
          label="Default exposure"
          value={exposure}
          onChange={setExposure}
          options={[
            { value: 'direct', label: 'Direct: list tools immediately' },
            { value: 'searchable', label: 'Searchable: agents discover on demand' },
          ]}
        />
        {error ? <Notice tone="error">{error}</Notice> : null}
        <div className="row end">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" data-variant="solid" disabled={busy}>
            {busy ? 'Creating…' : 'Create profile'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function ProfileEditor({
  profile,
  onChanged,
  onDeleted,
}: {
  profile: ProfileRecord;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const sources = useResource(() => api.sources(), []);
  const pool = useResource(() => api.capabilities({ profileId: profile.id }), [profile.id, profile.updatedAt]);
  const [name, setName] = useState(profile.name);
  const [description, setDescription] = useState(profile.description);
  const [exposure, setExposure] = useState<string>(profile.defaultExposure);
  const [budget, setBudget] = useState(String(profile.directToolBudget));
  const [rules, setRules] = useState<ProfileRule[]>(profile.rules);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const direct = useMemo(
    () => (pool.data ?? []).filter((c) => c.kind === 'tool' && c.exposure === 'direct' && c.available && c.permission !== 'deny'),
    [pool.data],
  );
  const searchable = (pool.data ?? []).filter((c) => c.exposure === 'searchable').length;
  const hidden = (pool.data ?? []).filter((c) => c.exposure === 'hidden').length;
  const budgetNumber = Math.max(0, Math.floor(Number(budget) || 0));
  const over = direct.length > profile.directToolBudget;
  const dirty =
    name !== profile.name ||
    description !== profile.description ||
    exposure !== profile.defaultExposure ||
    budgetNumber !== profile.directToolBudget ||
    JSON.stringify(rules) !== JSON.stringify(profile.rules);

  async function save() {
    setBusy(true);
    setError(undefined);
    try {
      await api.updateProfile(profile.id, {
        name: name.trim(),
        description,
        defaultExposure: exposure as 'direct' | 'searchable',
        directToolBudget: budgetNumber,
        rules,
      });
      notify.success('Profile saved', name);
      onChanged();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!(await ask(`Delete ${profile.name}?`, 'Tokens minted for this profile stop working.', 'Delete profile'))) return;
    if (await attempt(() => api.deleteProfile(profile.id), `Deleted ${profile.name}`)) onDeleted();
  }

  return (
    <>
      <Card title={`Edit ${profile.name}`} description="Exposure decides how much lands in an agent's context." level={2}>
        <div className="stack">
          <div className="form-row">
            <TextField label="Name" value={name} onChange={setName} required />
            <SelectField
              label="Default exposure"
              value={exposure}
              onChange={setExposure}
              options={[
                { value: 'direct', label: 'Direct: list tools immediately' },
                { value: 'searchable', label: 'Searchable: agents discover on demand' },
              ]}
            />
          </div>
          <TextAreaField label="Description" value={description} onChange={setDescription} rows={2} />
          <TextField
            label="Direct tool budget"
            value={budget}
            onChange={setBudget}
            type="number"
            description="Maximum pooled tools exposed directly in tools/list, excluding the 4 built-in fabric_* tools."
          />

          <Meter value={direct.length} min={0} max={Math.max(profile.directToolBudget, direct.length, 1)} format={(v: number) => `${v} of ${profile.directToolBudget}`}>
            <MeterLabel>Direct tools in context (saved profile)</MeterLabel>
            <MeterValue />
            <MeterTrack data-over={over ? '' : undefined}>
              <MeterIndicator />
            </MeterTrack>
          </Meter>
          <p className="row wrap">
            {over ? <Pill tone="bad">over budget by {direct.length - profile.directToolBudget}</Pill> : <Pill tone="ok">within budget</Pill>}
            <Pill tone="info">{direct.length} direct tools</Pill>
            <Pill tone="ok">{searchable} searchable</Pill>
            <Pill tone="muted">{hidden} hidden</Pill>
          </p>
          <LoadState resource={pool} label="profile capabilities" />
          {direct.length > 0 ? (
            <details>
              <summary>Direct tools for this profile</summary>
              <ul className="plain columns">
                {direct.map((c) => (
                  <li key={c.id}>
                    <code>{c.exposedName}</code>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      </Card>

      <Card title="Visibility & permission rules" description="Rules narrow or widen what this profile sees. Later matching rules set exposure; permissions keep the strictest match (deny > require_approval > allow).">
        <RulesEditor rules={rules} onChange={setRules} sources={(sources.data ?? []).map((s) => ({ value: s.id, label: s.name }))} />
        {error ? <Notice tone="error">{error}</Notice> : null}
        <div className="row end">
          <Button data-variant="destructive" onClick={remove} disabled={profile.id === 'default'}>
            Delete profile
          </Button>
          <Button data-variant="solid" onClick={save} disabled={busy || !dirty}>
            {busy ? 'Saving…' : dirty ? 'Save profile' : 'Saved'}
          </Button>
        </div>
      </Card>
    </>
  );
}

function RulesEditor({
  rules,
  onChange,
  sources,
}: {
  rules: ProfileRule[];
  onChange: (rules: ProfileRule[]) => void;
  sources: Array<{ value: string; label: string }>;
}) {
  const [sourceId, setSourceId] = useState(ANY);
  const [pattern, setPattern] = useState('');
  const [group, setGroup] = useState('');
  const [kind, setKind] = useState(ANY);
  const [exposure, setExposure] = useState(ANY);
  const [permission, setPermission] = useState(ANY);
  const [problem, setProblem] = useState<string>();

  function add() {
    if (exposure === ANY && permission === ANY) {
      setProblem('Choose an exposure or a permission for the rule to apply.');
      return;
    }
    if (sourceId === ANY && !pattern.trim() && !group.trim() && kind === ANY) {
      setProblem('Narrow the rule by source, pattern, group, or kind.');
      return;
    }
    setProblem(undefined);
    const rule: ProfileRule = {
      id: `rule_${crypto.randomUUID().slice(0, 8)}`,
      ...(sourceId !== ANY ? { sourceId } : {}),
      ...(pattern.trim() ? { capabilityPattern: pattern.trim() } : {}),
      ...(group.trim() ? { group: group.trim() } : {}),
      ...(kind !== ANY ? { kind: kind as CapabilityKind } : {}),
      ...(exposure !== ANY ? { exposure: exposure as ExposureTier } : {}),
      ...(permission !== ANY ? { permission: permission as RulePermission } : {}),
    };
    onChange([...rules, rule]);
    setPattern('');
    setGroup('');
  }

  const sourceName = (id?: string) => sources.find((s) => s.value === id)?.label ?? id;

  return (
    <div className="stack">
      <DataTable
        caption="Profile rules"
        empty="No rules. The profile's default exposure applies to everything."
        rows={rules}
        rowKey={(r) => r.id}
        columns={[
          {
            header: 'Matches',
            rowHeader: true,
            cell: (r) =>
              [
                r.sourceId ? `source ${sourceName(r.sourceId)}` : '',
                r.capabilityPattern ? `pattern ${r.capabilityPattern}` : '',
                r.capabilityId ? `capability ${r.capabilityId}` : '',
                r.group ? `group ${r.group}` : '',
                r.kind ? `kind ${r.kind}` : '',
              ]
                .filter(Boolean)
                .join(' · ') || 'everything',
          },
          { header: 'Exposure', cell: (r) => (r.exposure ? <Pill tone="info">{r.exposure}</Pill> : <span className="muted">inherit</span>) },
          {
            header: 'Permission',
            cell: (r) =>
              r.permission ? <Pill tone={r.permission === 'allow' ? 'ok' : r.permission === 'deny' ? 'bad' : 'warn'}>{r.permission.replace('_', ' ')}</Pill> : <span className="muted">inherit</span>,
          },
          {
            header: 'Actions',
            cell: (r) => (
              <Button data-size="sm" data-variant="destructive" onClick={() => onChange(rules.filter((x) => x.id !== r.id))} aria-label="Remove rule">
                <TrashIcon aria-hidden="true" /> Remove
              </Button>
            ),
          },
        ]}
      />
      <fieldset className="stack tight">
        <legend>Add a rule</legend>
        <div className="filters">
          <SelectField label="Source" value={sourceId} onChange={setSourceId} options={[{ value: ANY, label: 'Any source' }, ...sources]} />
          <TextField label="Capability pattern" value={pattern} onChange={setPattern} placeholder="*delete*" />
          <TextField label="Semantic group" value={group} onChange={setGroup} />
          <SelectField
            label="Kind"
            value={kind}
            onChange={setKind}
            options={[
              { value: ANY, label: 'Any kind' },
              { value: 'tool', label: 'Tools' },
              { value: 'prompt', label: 'Prompts' },
              { value: 'resource', label: 'Resources' },
              { value: 'skill', label: 'Skills' },
            ]}
          />
          <SelectField
            label="Set exposure"
            value={exposure}
            onChange={setExposure}
            options={[
              { value: ANY, label: 'Inherit' },
              { value: 'direct', label: 'Direct' },
              { value: 'searchable', label: 'Searchable' },
              { value: 'hidden', label: 'Hidden' },
            ]}
          />
          <SelectField
            label="Set permission"
            value={permission}
            onChange={setPermission}
            options={[
              { value: ANY, label: 'Inherit' },
              { value: 'allow', label: 'Allow' },
              { value: 'require_approval', label: 'Require approval' },
              { value: 'deny', label: 'Deny' },
            ]}
          />
        </div>
        {problem ? <Notice tone="warn">{problem}</Notice> : null}
        <div className="row">
          <Button onClick={add}>
            <PlusIcon aria-hidden="true" /> Add rule
          </Button>
          <span className="muted">Rules take effect after you save the profile.</span>
        </div>
      </fieldset>
    </div>
  );
}
