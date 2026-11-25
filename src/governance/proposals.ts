import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { GatewayError, type CapabilityProposalRecord, type CreateSourceInput, type SecretStore, type SourceRecord, type StorageAdapter } from '../types/index.js';
import { ensureSecretFree, parseConfig, sourceConfigSchema } from '../storage/portability.js';
import { validateComposite } from '../upstreams/composite.js';
import { parseGitHubSkillUrl } from '../upstreams/github-skills.js';

const proposalKinds = ['cli_wrapper', 'composite', 'skill', 'skill_repo'] as const;

const proposalSchema = z.strictObject({
  name: z.string().min(1), description: z.string(),
  definition: sourceConfigSchema.refine(config => (proposalKinds as readonly string[]).includes(config.kind)),
  kind: z.enum(proposalKinds).optional(),
});

export class Proposals {
  private readonly reviewing = new Set<string>();
  constructor(private readonly storage: StorageAdapter, private readonly secrets: SecretStore,
    private readonly emit: (proposal: CapabilityProposalRecord) => Promise<unknown>) {}

  async create(input: unknown, profileId: string, proposedBySessionId?: string) {
    if ((await this.storage.listProposals('pending_review')).length >= 50) {
      throw new GatewayError('CONFLICT', 'Too many pending capability proposals; review existing proposals first');
    }
    const { name, description, definition, kind } = parseConfig(proposalSchema, input);
    if (!(proposalKinds as readonly string[]).includes(definition.kind) || (kind && kind !== definition.kind)) {
      throw new GatewayError('INVALID_INPUT', 'Invalid proposal kind');
    }
    const proposalKind = definition.kind as CapabilityProposalRecord['kind'];
    if (definition.kind === 'composite') validateComposite(definition);
    if (definition.kind === 'skill_repo') parseGitHubSkillUrl(definition.url, { ref: definition.ref, path: definition.path });
    ensureSecretFree({ name, description, definition }, this.secrets);
    const proposal: CapabilityProposalRecord = { id: randomUUID(), kind: proposalKind, name, description, definition: definition as CapabilityProposalRecord['definition'],
      profileId, proposedBySessionId, status: 'pending_review', createdAt: new Date().toISOString() };
    await this.storage.upsertProposal(proposal);
    await this.emit(proposal).catch(() => {});
    return proposal;
  }

  private async review<T>(id: string, operation: (proposal: CapabilityProposalRecord) => Promise<T>) {
    if (this.reviewing.has(id)) throw new GatewayError('CONFLICT', 'Proposal review is in progress');
    this.reviewing.add(id);
    try {
      const proposal = await this.storage.getProposal(id);
      if (!proposal) throw new GatewayError('NOT_FOUND', 'Proposal does not exist');
      if (proposal.status !== 'pending_review') throw new GatewayError('CONFLICT', 'Proposal has already been reviewed');
      return await operation(proposal);
    } finally { this.reviewing.delete(id); }
  }

  activate(id: string, createSource: (input: CreateSourceInput) => Promise<SourceRecord>, note?: string) {
    return this.review(id, async proposal => {
      const sourceId = `proposal-${id}`;
      const source = await this.storage.getSource(sourceId) ?? await createSource({
        id: sourceId, name: proposal.name, kind: proposal.kind, config: proposal.definition,
      });
      const updated: CapabilityProposalRecord = { ...proposal, status: 'activated', activatedSourceId: source.id,
        reviewedAt: new Date().toISOString(), reviewNote: note === undefined ? undefined : this.secrets.redact(note) };
      await this.storage.upsertProposal(updated);
      return { proposal: updated, source };
    });
  }

  reject(id: string, note?: string) {
    return this.review(id, async proposal => {
      const updated: CapabilityProposalRecord = { ...proposal, status: 'rejected', reviewedAt: new Date().toISOString(),
        reviewNote: note === undefined ? undefined : this.secrets.redact(note) };
      await this.storage.upsertProposal(updated);
      return updated;
    });
  }
}
