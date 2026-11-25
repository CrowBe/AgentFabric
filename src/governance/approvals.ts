import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { GatewayError, type ApprovalEvent, type ApprovalRequestRecord, type SecretStore, type StorageAdapter } from '../types/index.js';

type Emit = (name: string, approval: ApprovalRequestRecord) => Promise<unknown>;

export class Approvals {
  private readonly changes = new EventEmitter().setMaxListeners(0);
  private readonly locks = new Map<string, Promise<ApprovalRequestRecord>>();
  private readonly waiting = new Map<string, () => void>();
  private closed = false;

  constructor(private readonly storage: StorageAdapter, private readonly secrets: SecretStore,
    private readonly publicUrl: string, private readonly timeoutMs: number, private readonly emit: Emit) {}

  subscribe(listener: (event: ApprovalEvent) => void) {
    const wrapped = (event: ApprovalEvent) => { try { listener(event); } catch {} };
    this.changes.on('approval', wrapped);
    return () => { this.changes.off('approval', wrapped); };
  }

  private async announce(type: ApprovalEvent['type'], approval: ApprovalRequestRecord) {
    this.changes.emit('approval', { type, approval: structuredClone(approval) });
    await this.emit(type === 'created' ? 'fabric.approval.requested' : 'fabric.approval.decided', approval).catch(() => {});
  }

  private finish(id: string, decision?: 'approved' | 'denied', note?: string) {
    const prior = this.locks.get(id);
    const operation = (prior ?? Promise.resolve()).catch(() => {}).then(async () => {
      const record = await this.storage.getApproval(id);
      if (!record) throw new GatewayError('NOT_FOUND', 'Approval request does not exist');
      if (record.status !== 'pending') {
        if (decision) throw new GatewayError('CONFLICT', 'Approval has already been decided');
        return record;
      }
      const expired = !decision || this.closed || Date.parse(record.expiresAt) <= Date.now();
      const updated: ApprovalRequestRecord = {
        ...record, status: expired ? 'expired' : decision,
        decidedAt: new Date().toISOString(), decidedBy: expired ? undefined : 'operator',
        decisionNote: note === undefined ? undefined : this.secrets.redact(note),
      };
      await this.storage.upsertApproval(updated);
      await this.announce('updated', updated);
      if (decision && expired) throw new GatewayError('CONFLICT', 'Approval has expired');
      return updated;
    });
    this.locks.set(id, operation);
    return operation.finally(() => { if (this.locks.get(id) === operation) this.locks.delete(id); });
  }

  decide(id: string, decision: 'approved' | 'denied', note?: string) {
    if (decision !== 'approved' && decision !== 'denied') throw new GatewayError('INVALID_INPUT', 'Invalid approval decision');
    return this.finish(id, decision, note);
  }

  async expirePending() {
    const pending = await this.storage.listApprovals('pending');
    await Promise.all(pending.filter(row => Date.parse(row.expiresAt) <= Date.now()).map(row => this.finish(row.id)));
  }

  async require(
    input: Pick<ApprovalRequestRecord, 'profileId' | 'sessionId' | 'clientName' | 'sourceId' | 'capabilityId' | 'toolName' | 'reason'>,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    if (this.closed) throw new GatewayError('UPSTREAM_UNAVAILABLE', 'Gateway is closing');
    if (signal?.aborted) throw new GatewayError('APPROVAL_TIMEOUT', 'Caller cancelled before approval wait');
    const id = randomUUID();
    const now = Date.now();
    const approvalUrl = `${this.publicUrl}/#/safety?approval=${encodeURIComponent(id)}`;
    const approval: ApprovalRequestRecord = {
      ...input, id, redactedArguments: this.secrets.redactValue(args), status: 'pending',
      createdAt: new Date(now).toISOString(), expiresAt: new Date(now + this.timeoutMs).toISOString(),
    };
    await this.storage.upsertApproval(approval);
    let timer: NodeJS.Timeout | undefined;
    let listener: ((event: ApprovalEvent) => void) | undefined;
    let onAbort: (() => void) | undefined;
    const resolved = new Promise<ApprovalRequestRecord>((resolve, reject) => {
      const expire = () => { void this.finish(id).then(resolve, reject); };
      onAbort = expire;
      listener = event => { if (event.type === 'updated' && event.approval.id === id) resolve(event.approval); };
      this.changes.on('approval', listener);
      this.waiting.set(id, expire);
      timer = setTimeout(expire, Math.max(0, Date.parse(approval.expiresAt) - Date.now()));
      if (signal) signal.addEventListener('abort', expire, { once: true });
      if (this.closed || signal?.aborted) expire();
      void this.storage.getApproval(id).then(record => {
        if (record && record.status !== 'pending') resolve(record);
      }, reject);
    });
    try {
      await this.announce('created', approval);
      const decision = await resolved;
      if (decision.status === 'approved' && !this.closed && !signal?.aborted) return;
      const status = decision.status === 'denied' ? 'denied' : 'expired';
      const baseReason = status === 'denied'
        ? 'Operator denied the approval request'
        : signal?.aborted
          ? 'Caller disconnected or cancelled approval request'
          : 'Approval request expired';
      const reason = `${baseReason} (${approvalUrl})`;
      throw new GatewayError(status === 'denied' ? 'APPROVAL_DENIED' : 'APPROVAL_TIMEOUT', reason, {
        approval: { approvalId: id, approvalUrl, status, reason: baseReason },
      });
    } finally {
      clearTimeout(timer);
      if (listener) this.changes.off('approval', listener);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      this.waiting.delete(id);
    }
  }

  async close() {
    this.closed = true;
    for (const expire of this.waiting.values()) expire();
    await Promise.allSettled(this.locks.values());
    this.changes.removeAllListeners();
  }
}
