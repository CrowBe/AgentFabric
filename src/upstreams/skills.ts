import { createHash } from 'node:crypto';
import { SKILL_LIMITS, type Skill } from '@modelcontextprotocol/server/ext/skills';
import { GatewayError, type CapabilityRecord, type SkillSourceConfig } from '../types/index.js';

export function skillEntry(config: SkillSourceConfig, redact: (value: string) => string = value => value): Skill {
  const uri = `skill://${config.slug}`;
  const content = redact(config.content);
  const size = Buffer.byteLength(content);
  if (size > SKILL_LIMITS.bytes) throw new GatewayError('INVALID_INPUT', 'Skill exceeds the MCP size limit');
  return {
    uri, frontmatter: { name: config.slug, description: redact(config.description), title: redact(config.title) },
    resources: [{ uri, size, digest: 'sha256:' + createHash('sha256').update(content).digest('hex') }],
  };
}

export function skillCapabilities(config: SkillSourceConfig): Pick<CapabilityRecord, 'kind' | 'originalName' | 'description' | 'mimeType' | 'uri' | 'metadata'>[] {
  const { uri } = skillEntry(config);
  return [
    { kind: 'skill', originalName: config.slug, description: config.description, uri, mimeType: 'text/markdown', metadata: { tags: config.tags ?? [] } },
    { kind: 'prompt', originalName: `skill:${config.slug}`, description: config.description },
  ];
}
