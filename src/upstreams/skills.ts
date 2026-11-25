import { createHash } from 'node:crypto';
import { SKILL_LIMITS, type Skill } from '@modelcontextprotocol/server/ext/skills';
import { GatewayError, type CapabilityRecord, type SkillSourceConfig } from '../types/index.js';
import type { DiscoveredRepoSkill } from './github-skills.js';

export interface StoredSkillMetadata {
  tags?: string[];
  title?: string;
  repoUrl?: string;
  repoRef?: string;
  repoPath?: string;
  skillSlug: string;
  skillContent: string;
  skillFrontmatter?: Record<string, unknown>;
  skillFiles?: Record<string, string>;
}

const MIME_BY_EXT: Record<string, string> = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.json': 'application/json',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.ts': 'text/typescript',
  '.mts': 'text/typescript',
  '.sh': 'text/x-shellscript',
  '.bash': 'text/x-shellscript',
  '.py': 'text/x-python',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.toml': 'text/toml',
  '.svg': 'image/svg+xml',
};

export function skillMimeType(relPath: string): string {
  const dot = relPath.lastIndexOf('.');
  if (dot === -1) return 'text/plain';
  return MIME_BY_EXT[relPath.slice(dot).toLowerCase()] ?? 'text/plain';
}

function digestOf(text: string): { size: number; digest: string } {
  return {
    size: Buffer.byteLength(text),
    digest: `sha256:${createHash('sha256').update(text).digest('hex')}`,
  };
}

export function skillEntry(config: SkillSourceConfig, redact: (value: string) => string = value => value): Skill {
  const uri = `skill://${config.slug}`;
  const content = redact(config.content);
  const { size, digest } = digestOf(content);
  if (size > SKILL_LIMITS.bytes) throw new GatewayError('INVALID_INPUT', 'Skill exceeds the MCP size limit');
  return {
    uri,
    frontmatter: { name: config.slug, description: redact(config.description), title: redact(config.title) },
    resources: [{ uri, size, digest }],
  };
}

export function skillCapabilities(
  config: SkillSourceConfig,
): Pick<CapabilityRecord, 'kind' | 'originalName' | 'description' | 'mimeType' | 'uri' | 'metadata'>[] {
  const { uri } = skillEntry(config);
  return [
    {
      kind: 'skill',
      originalName: config.slug,
      description: config.description,
      uri,
      mimeType: 'text/markdown',
      metadata: { tags: config.tags ?? [] },
    },
    { kind: 'prompt', originalName: `skill:${config.slug}`, description: config.description },
  ];
}

export function repoSkillEntry(
  slug: string,
  meta: StoredSkillMetadata,
  redact: (value: string) => string = value => value,
): Skill {
  const uri = `skill://${slug}`;
  const content = redact(meta.skillContent);
  const main = digestOf(content);
  let totalBytes = main.size;
  const resources = [{ uri, size: main.size, digest: main.digest }];
  for (const [relPath, rawFile] of Object.entries(meta.skillFiles ?? {})) {
    const fileText = redact(rawFile);
    const info = digestOf(fileText);
    totalBytes += info.size;
    if (resources.length >= SKILL_LIMITS.files || totalBytes > SKILL_LIMITS.bytes) {
      throw new GatewayError('INVALID_INPUT', 'Skill exceeds the MCP size limit');
    }
    resources.push({ uri: `${uri}/${relPath}`, size: info.size, digest: info.digest });
  }
  const fm = meta.skillFrontmatter ?? {};
  return {
    uri,
    frontmatter: {
      name: redact(typeof fm.name === 'string' && fm.name ? fm.name : slug),
      description: redact(typeof fm.description === 'string' ? fm.description : ''),
      ...(meta.title ? { title: redact(meta.title) } : {}),
    },
    resources,
  };
}

export function repoSkillCapabilities(
  skill: DiscoveredRepoSkill,
  repoInfo: { url: string; ref?: string; path?: string },
): Pick<CapabilityRecord, 'kind' | 'originalName' | 'description' | 'mimeType' | 'uri' | 'metadata'>[] {
  const uri = `skill://${skill.slug}`;
  return [
    {
      kind: 'skill',
      originalName: skill.slug,
      description: skill.description,
      uri,
      mimeType: 'text/markdown',
      metadata: {
        tags: skill.tags,
        title: skill.title,
        repoUrl: repoInfo.url,
        ...(repoInfo.ref ? { repoRef: repoInfo.ref } : {}),
        ...(repoInfo.path ? { repoPath: repoInfo.path } : {}),
        skillSlug: skill.slug,
        skillContent: skill.content,
        skillFrontmatter: skill.frontmatter,
        skillFiles: skill.files,
      },
    },
    {
      kind: 'prompt',
      originalName: `skill:${skill.slug}`,
      description: skill.description,
      metadata: {
        tags: skill.tags,
        skillSlug: skill.slug,
        skillContent: skill.content,
      },
    },
  ];
}
