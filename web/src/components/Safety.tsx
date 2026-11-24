import { useState } from 'react';
import { CheckIcon, ShieldCheckIcon, SparklesIcon, TrashIcon, XIcon } from 'lucide-react';
import type { RulePermission } from '../../../src/types/index.js';
import {
  api,
  describeError,
  type ApprovalRequestRecord,
  type CapabilityProposalRecord,
} from '../api';
import { useApprovals } from './approvals';
import {
  Button,
  Card,
  CodeBlock,
  DataTable,
  LoadState,
  Modal,
  Notice,
  Pill,
  SelectField,
  SwitchField,
  TextAreaField,
  TextField,
  ask,
  attempt,
  formatRelative,
  formatTime,
  json,
  notify,
  useResource,
} from './ui';

export function Safety() {
  return (
    <div className="stack">
      <h1>Safety &amp; Approvals</h1>
      <ApprovalQueue />
      <ProposalQueue />
      <PolicyManager />
      <ApprovalHistory />
    </div>
  );
}

function ApprovalQueue() {
  const { pending, connected, decide } = useApprovals();
  return (
    <Card
      title="Pending approvals"
      description="Agents wait here for your decision. This list updates live."
      actions={<Pill tone={connected ? 'ok' : 'warn'}>{connected ? 'live' : 'reconnecting…'}</Pill>}
    >
      {pending.length === 0 ? <p className="empty">Nothing is waiting for approval.</p> : null}
      <div className="stack">
        {pending.map((approval) => (
          <ApprovalCard key={approval.id} approval={approval} onDecide={decide} />
        ))}
      </div>
    </Card>
  );
}

function ApprovalCard({
  approval,
  onDecide,
}: {
  approval: ApprovalRequestRecord;
  onDecide: (id: string, decision: 'approved' | 'denied', note?: string) => Promise<void>;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  async function decide(decision: 'approved' | 'denied') {
    setBusy(true);
    const ok = await attempt(() => onDecide(approval.id, decision, note.trim() || undefined), decision === 'approved' ? 'Approved' : 'Denied');
    if (ok === undefined) setBusy(false);
  }
  return (
    <article className="mini-card" aria-label={`Approval for ${approval.toolName}`}>
      <header>
        <h3>{approval.toolName}</h3>
        <Pill tone="warn">expires {formatRelative(approval.expiresAt)}</Pill>
      </header>
      <p>{approval.reason}</p>
      <p className="muted">
        Profile <strong>{approval.profileId}</strong>
        {approval.clientName ? <> · client {approval.clientName}</> : null} · requested {formatRelative(approval.createdAt)}
      </p>
      <CodeBlock text={json(approval.redactedArguments)} label="redacted arguments" />
      <TextField label="Note (optional)" value={note} onChange={setNote} />
      <div className="row end">
        <Button data-variant="destructive" disabled={busy} onClick={() => decide('denied')} aria-label={`Deny ${approval.toolName}`}>
          <XIcon aria-hidden="true" /> Deny
        </Button>
        <Button data-variant="solid" disabled={busy} onClick={() => decide('approved')} aria-label={`Approve ${approval.toolName}`}>
          <CheckIcon aria-hidden="true" /> Approve
        </Button>
      </div>
    </article>
  );
}

function ProposalQueue() {
  const proposals = useResource(() => api.proposals('pending_review'), [], { intervalMs: 20_000 });
  const [inspecting, setInspecting] = useState<CapabilityProposalRecord>();
  const [note, setNote] = useState('');

  async function activate(proposal: CapabilityProposalRecord) {
    const yes = await ask(
      `Activate ${proposal.name}?`,
      'This adds an agent-drafted capability to the pool. Inspect the definition first: it will be callable by profiles that can see it.',
      'Activate',
    );
    if (!yes) return;
    if (await attempt(() => api.activateProposal(proposal.id, note.trim() || undefined), `Activated ${proposal.name}`)) {
      setInspecting(undefined);
      setNote('');
      await proposals.reload();
    }
  }
  async function reject(proposal: CapabilityProposalRecord) {
    if (await attempt(() => api.rejectProposal(proposal.id, note.trim() || undefined), `Rejected ${proposal.name}`)) {
      setInspecting(undefined);
      setNote('');
      await proposals.reload();
    }
  }

  return (
    <Card
      title="Capability proposals"
      description="Agents can draft CLI wrappers or composite tools to fill gaps. Nothing runs until you activate it."
    >
      <LoadState resource={proposals} label="proposals" />
      <DataTable
        caption="Proposals awaiting review"
        empty="No proposals to review."
        rows={proposals.data ?? []}
        rowKey={(p) => p.id}
        columns={[
          { header: 'Proposal', rowHeader: true, cell: (p) => <><strong>{p.name}</strong><small className="muted block">{p.description}</small></> },
          { header: 'Kind', cell: (p) => <Pill tone="info">{p.kind.replace('_', ' ')}</Pill> },
          { header: 'Profile', cell: (p) => p.profileId ?? '—' },
          { header: 'Drafted', cell: (p) => formatRelative(p.createdAt) },
          {
            header: 'Actions',
            cell: (p) => (
              <Button data-size="sm" onClick={() => setInspecting(p)} aria-label={`Inspect ${p.name}`}>
                Inspect
              </Button>
            ),
          },
        ]}
      />
      <Modal
        open={inspecting !== undefined}
        onClose={() => setInspecting(undefined)}
        wide
        title={inspecting ? `Inspect ${inspecting.name}` : 'Inspect proposal'}
        description="Review the exact definition before it can run."
      >
        {inspecting ? (
          <div className="stack">
            <p>{inspecting.description}</p>
            <CodeBlock text={json(inspecting.definition)} label="definition" />
            <TextField label="Review note (optional)" value={note} onChange={setNote} />
            <div className="row end">
              <Button data-variant="destructive" onClick={() => reject(inspecting)}>
                Reject
              </Button>
              <Button data-variant="solid" onClick={() => activate(inspecting)}>
                Activate…
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>
    </Card>
  );
}

function PolicyManager() {
  const policies = useResource(() => api.policies(), []);
  const profiles = useResource(() => api.profiles(), []);
  const sources = useResource(() => api.sources(), []);
  const [description, setDescription] = useState('');
  const [draftProfile, setDraftProfile] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [name, setName] = useState('');
  const [pattern, setPattern] = useState('');
  const [action, setAction] = useState<RulePermission>('require_approval');
  const [reason, setReason] = useState('');
  const [profileId, setProfileId] = useState('');
  const [sourceId, setSourceId] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [draftedBy, setDraftedBy] = useState<string>();
  const [error, setError] = useState<string>();

  async function draft() {
    setDrafting(true);
    setError(undefined);
    try {
      const result = await api.draftPolicy({
        description: description.trim(),
        ...(draftProfile ? { profileId: draftProfile } : {}),
      });
      setName(result.name);
      setPattern(result.capabilityPattern);
      setAction(result.action);
      setReason(result.reason ?? '');
      setProfileId(result.profileId ?? '');
      setSourceId(result.sourceId ?? '');
      setEnabled(result.enabled);
      setDraftedBy(result.draftedBy ?? 'the assistant');
      notify.success('Policy drafted', 'Review it below, then save.');
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setDrafting(false);
    }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setError(undefined);
    try {
      await api.createPolicy({
        name: name.trim(),
        capabilityPattern: pattern.trim(),
        action,
        enabled,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(profileId ? { profileId } : {}),
        ...(sourceId ? { sourceId } : {}),
        ...(draftedBy ? { draftedBy } : {}),
      });
      notify.success('Policy saved', name);
      setName('');
      setPattern('');
      setReason('');
      setDraftedBy(undefined);
      await policies.reload();
    } catch (caught) {
      setError(describeError(caught));
    }
  }

  async function remove(id: string, label: string) {
    if (!(await ask(`Delete policy ${label}?`, 'Calls it governed fall back to profile rules.', 'Delete policy'))) return;
    if (await attempt(() => api.deletePolicy(id), 'Policy deleted')) await policies.reload();
  }

  const profileOptions = [{ value: '', label: 'All profiles' }, ...(profiles.data ?? []).map((p) => ({ value: p.id, label: p.name }))];
  const sourceOptions = [{ value: '', label: 'All sources' }, ...(sources.data ?? []).map((s) => ({ value: s.id, label: s.name }))];

  return (
    <Card title="Safety policies" description="Approval gates for sensitive or destructive actions. They apply across every harness.">
      <LoadState resource={policies} label="policies" />
      <DataTable
        caption="Active safety policies"
        empty="No policies yet."
        rows={policies.data ?? []}
        rowKey={(p) => p.id}
        columns={[
          { header: 'Policy', rowHeader: true, cell: (p) => <><strong>{p.name}</strong>{p.reason ? <small className="muted block">{p.reason}</small> : null}</> },
          { header: 'Pattern', cell: (p) => <code>{p.capabilityPattern}</code> },
          { header: 'Action', cell: (p) => <Pill tone={p.action === 'allow' ? 'ok' : p.action === 'deny' ? 'bad' : 'warn'}>{p.action.replace('_', ' ')}</Pill> },
          { header: 'Scope', cell: (p) => [p.profileId ? `profile ${p.profileId}` : 'all profiles', p.sourceId ? `source ${p.sourceId}` : ''].filter(Boolean).join(' · ') },
          { header: 'State', cell: (p) => (p.enabled ? <Pill tone="ok">enabled</Pill> : <Pill tone="muted">disabled</Pill>) },
          { header: 'Updated', cell: (p) => formatTime(p.updatedAt) },
          {
            header: 'Actions',
            cell: (p) => (
              <Button data-size="sm" data-variant="destructive" onClick={() => remove(p.id, p.name)} aria-label={`Delete policy ${p.name}`}>
                <TrashIcon aria-hidden="true" /> Delete
              </Button>
            ),
          },
        ]}
      />

      <form className="stack policy-form" onSubmit={save}>
        <h3>New policy</h3>
        <div className="draft-box">
          <TextAreaField
            label="Describe the rule in plain language"
            value={description}
            onChange={setDescription}
            rows={2}
            placeholder="Ask me before anything deletes or overwrites data."
          />
          <Button type="button" onClick={draft} disabled={drafting || !description.trim()}>
            <SparklesIcon aria-hidden="true" /> {drafting ? 'Drafting…' : 'Draft with LLM'}
          </Button>
        </div>
        {draftedBy ? <Notice tone="info" title="Draft loaded">Drafted by {draftedBy}. Edit, then save. Nothing is enforced until you save.</Notice> : null}
        <SelectField label="Draft for profile" value={draftProfile} onChange={setDraftProfile} options={profileOptions} />
        <div className="form-row">
          <TextField label="Name (required)" value={name} onChange={setName} required />
          <TextField label="Capability pattern (required)" value={pattern} onChange={setPattern} required placeholder="*delete*" mono />
        </div>
        <div className="form-row">
          <SelectField
            label="Action"
            value={action}
            onChange={(v) => setAction(v as RulePermission)}
            options={[
              { value: 'require_approval', label: 'Require approval' },
              { value: 'deny', label: 'Deny' },
              { value: 'allow', label: 'Allow' },
            ]}
          />
          <TextField label="Reason shown in approvals" value={reason} onChange={setReason} />
        </div>
        <div className="form-row">
          <SelectField label="Profile scope" value={profileId} onChange={setProfileId} options={profileOptions} />
          <SelectField label="Source scope" value={sourceId} onChange={setSourceId} options={sourceOptions} />
        </div>
        <SwitchField label="Enabled" checked={enabled} onChange={setEnabled} />
        {error ? <Notice tone="error">{error}</Notice> : null}
        <div className="row end">
          <Button type="submit" data-variant="solid">
            <ShieldCheckIcon aria-hidden="true" /> Save policy
          </Button>
        </div>
      </form>
    </Card>
  );
}

function ApprovalHistory() {
  const [status, setStatus] = useState('approved');
  const history = useResource(() => api.approvals(status as 'approved' | 'denied' | 'expired'), [status]);
  return (
    <Card title="Approval history" description="Past decisions, for audit.">
      <SelectField
        label="Show"
        value={status}
        onChange={setStatus}
        options={[
          { value: 'approved', label: 'Approved' },
          { value: 'denied', label: 'Denied' },
          { value: 'expired', label: 'Expired' },
        ]}
      />
      <LoadState resource={history} label="history" />
      <DataTable
        caption="Decided approvals"
        empty="No decisions in this state."
        rows={history.data ?? []}
        rowKey={(a) => a.id}
        columns={[
          { header: 'Tool', rowHeader: true, cell: (a) => a.toolName },
          { header: 'Profile', cell: (a) => a.profileId },
          { header: 'Status', cell: (a) => <Pill tone={a.status === 'approved' ? 'ok' : a.status === 'denied' ? 'bad' : 'muted'}>{a.status}</Pill> },
          { header: 'Decided', cell: (a) => formatTime(a.decidedAt) },
          { header: 'Note', cell: (a) => a.decisionNote ?? '—' },
        ]}
      />
    </Card>
  );
}
