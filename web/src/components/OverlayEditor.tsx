import { useEffect, useState } from 'react';
import { SparklesIcon } from 'lucide-react';
import { api, describeError, type EffectiveCapability, type NormalizationOverlay } from '../api';
import {
  Button,
  Modal,
  Notice,
  Pill,
  SelectField,
  TextAreaField,
  TextField,
  ask,
  lines,
  notify,
} from './ui';

interface Draft {
  displayName: string;
  description: string;
  semanticGroup: string;
  tags: string;
  defaultExposure: string;
  parameterDescriptions: Record<string, string>;
  draftedBy?: string;
  draftModel?: string;
}

function schemaProperties(capability: EffectiveCapability): string[] {
  const properties = (capability.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  return properties ? Object.keys(properties) : [];
}

function toDraft(capability: EffectiveCapability, overlay?: NormalizationOverlay): Draft {
  return {
    displayName: overlay?.displayName ?? capability.exposedName,
    description: overlay?.description ?? capability.description,
    semanticGroup: overlay?.semanticGroup ?? capability.semanticGroup,
    tags: (overlay?.tags ?? capability.tags).join(', '),
    defaultExposure: overlay?.defaultExposure ?? capability.exposure,
    parameterDescriptions: { ...(overlay?.parameterDescriptions ?? {}) },
    draftedBy: overlay?.draftedBy,
    draftModel: overlay?.draftModel,
  };
}

export function OverlayEditor({
  capability,
  onClose,
  onChanged,
}: {
  capability: EffectiveCapability | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState<Draft>();
  const [guidance, setGuidance] = useState('');
  const [busy, setBusy] = useState<'draft' | 'apply' | 'clear'>();
  const [error, setError] = useState<string>();
  const [unapplied, setUnapplied] = useState(false);

  useEffect(() => {
    setDraft(capability ? toDraft(capability, capability.overlay) : undefined);
    setGuidance('');
    setError(undefined);
    setUnapplied(false);
  }, [capability]);

  if (!capability || !draft) return <Modal open={false} onClose={onClose} title="Normalise capability">{null}</Modal>;
  const cap = capability;
  const params = schemaProperties(cap);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => (d ? { ...d, [key]: value } : d));

  async function runDraft() {
    setBusy('draft');
    setError(undefined);
    try {
      const overlay = await api.draftOverlay(cap.id, guidance.trim() || undefined);
      setDraft(toDraft(cap, overlay));
      setUnapplied(true);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(undefined);
    }
  }

  async function apply() {
    if (!draft) return;
    setBusy('apply');
    setError(undefined);
    try {
      const parameterDescriptions = Object.fromEntries(
        Object.entries(draft.parameterDescriptions).filter(([, text]) => text.trim()),
      );
      await api.applyOverlay(cap.id, {
        displayName: draft.displayName.trim() || undefined,
        description: draft.description.trim() || undefined,
        semanticGroup: draft.semanticGroup.trim() || undefined,
        tags: lines(draft.tags),
        defaultExposure: draft.defaultExposure || undefined,
        ...(Object.keys(parameterDescriptions).length ? { parameterDescriptions } : {}),
        ...(draft.draftedBy ? { draftedBy: draft.draftedBy } : {}),
        ...(draft.draftModel ? { draftModel: draft.draftModel } : {}),
      });
      notify.success('Overlay applied', cap.exposedName);
      onChanged();
      onClose();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(undefined);
    }
  }

  async function clear() {
    if (!(await ask('Clear this overlay?', 'The capability goes back to its original upstream name and description.', 'Clear overlay'))) return;
    setBusy('clear');
    try {
      await api.clearOverlay(cap.id);
      notify.success('Overlay cleared');
      onChanged();
      onClose();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      wide
      title={`Normalise ${cap.originalName}`}
      description="Overlays are opt-in. A drafted overlay changes nothing until you apply it."
    >
      <div className="stack">
        <p className="muted">
          {cap.kind} from <strong>{cap.sourceName}</strong> · upstream name <code>{cap.originalName}</code>
          {cap.hasOverlay ? <> · <Pill tone="info">overlay active</Pill></> : null}
        </p>
        <div className="draft-box">
          <TextField
            label="Guidance for the drafting LLM (optional)"
            value={guidance}
            onChange={setGuidance}
            placeholder="Keep names familiar. Group with other calendar tools."
          />
          <Button onClick={runDraft} disabled={busy !== undefined}>
            <SparklesIcon aria-hidden="true" /> {busy === 'draft' ? 'Drafting…' : 'Draft normalisation (LLM)'}
          </Button>
        </div>
        {unapplied ? (
          <Notice tone="info" title="Unapplied draft">
            Drafted by {draft.draftedBy ?? 'the assistant'}
            {draft.draftModel ? ` (${draft.draftModel})` : ''}. Edit freely, then apply.
          </Notice>
        ) : null}
        <TextField
          label="Display name"
          value={draft.displayName}
          onChange={(v) => set('displayName', v)}
          description="Keep the natural domain identifier unless it is genuinely unclear."
        />
        <TextAreaField label="Description" value={draft.description} onChange={(v) => set('description', v)} rows={3} />
        <div className="form-row">
          <TextField label="Semantic group" value={draft.semanticGroup} onChange={(v) => set('semanticGroup', v)} />
          <TextField label="Tags (comma separated)" value={draft.tags} onChange={(v) => set('tags', v)} />
        </div>
        <SelectField
          label="Default exposure"
          value={draft.defaultExposure}
          onChange={(v) => set('defaultExposure', v)}
          options={[
            { value: 'direct', label: 'Direct (listed to the agent)' },
            { value: 'searchable', label: 'Searchable (found via discovery)' },
            { value: 'hidden', label: 'Hidden' },
          ]}
        />
        {params.length > 0 ? (
          <fieldset className="stack tight">
            <legend>Parameter descriptions</legend>
            {params.map((param) => (
              <TextField
                key={param}
                label={param}
                value={draft.parameterDescriptions[param] ?? ''}
                onChange={(v) => set('parameterDescriptions', { ...draft.parameterDescriptions, [param]: v })}
              />
            ))}
          </fieldset>
        ) : null}
        {error ? <Notice tone="error">{error}</Notice> : null}
        <div className="row end">
          {cap.hasOverlay ? (
            <Button data-variant="destructive" onClick={clear} disabled={busy !== undefined}>
              Clear overlay
            </Button>
          ) : null}
          <Button onClick={onClose}>Cancel</Button>
          <Button data-variant="solid" onClick={apply} disabled={busy !== undefined}>
            {busy === 'apply' ? 'Applying…' : 'Apply overlay'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
