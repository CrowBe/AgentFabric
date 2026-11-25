import { skillEntry as sdkSkillEntry } from '@modelcontextprotocol/server/ext/skills';
import { GatewayError, type SkillRepoSourceConfig } from '../types/index.js';

export const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024;
export const MAX_SKILLS_PER_REPO = 256;
export const MAX_SKILL_MD_BYTES = 256 * 1024;
export const MAX_SIBLING_FILE_BYTES = 128 * 1024;
export const MAX_SIBLING_FILES_PER_SKILL = 32;
export const MAX_SIBLING_TOTAL_BYTES = 512 * 1024;
export const MAX_SPARSE_FILE_FETCHES = 64;

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.github']);
const decoder = new TextDecoder('utf-8', { fatal: false });
const strictDecoder = new TextDecoder('utf-8', { fatal: true });
const SYMLINK_MODE = '120000';

function decodeText(bytes: Uint8Array): string | undefined {
  try {
    return strictDecoder.decode(bytes);
  } catch {
    return undefined;
  }
}

export interface ParsedGitHubSkillRef {
  owner: string;
  repo: string;
  canonicalUrl: string;
  ref?: string;
  path?: string;
}

export interface DiscoveredRepoSkill {
  slug: string;
  title: string;
  description: string;
  content: string;
  frontmatter: Record<string, unknown>;
  files: Record<string, string>;
  tags: string[];
  sourcePath: string;
}

interface ExtractedTarFile {
  path: string;
  bytes: Uint8Array;
}

function invalid(message: string): GatewayError {
  return new GatewayError('INVALID_INPUT', message);
}

function validateRef(raw: string): string {
  const ref = raw.trim().replace(/^\/+|\/+$/g, '');
  if (
    !ref ||
    ref.includes('..') ||
    ref.includes('//') ||
    ref.includes('\\') ||
    ref.includes('#') ||
    ref.includes('?') ||
    /[\x00-\x20\x7f]/.test(ref)
  ) {
    throw invalid(`Invalid GitHub git ref '${raw}'`);
  }
  return ref;
}

function sanitizeSubpath(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim().replace(/^\/+|\/+$/g, '');
  if (!trimmed) return undefined;
  if (trimmed.includes('\0') || trimmed.includes('\\')) {
    throw invalid('GitHub path contains invalid characters');
  }
  const parts = trimmed.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw invalid('GitHub path cannot contain empty or traversal segments');
  }
  return parts.join('/');
}

function decodeSegments(pathname: string): string[] {
  const rawParts = pathname.split('/').filter(Boolean);
  const decoded: string[] = [];
  for (const part of rawParts) {
    let seg: string;
    try {
      seg = decodeURIComponent(part);
    } catch {
      throw invalid('Malformed URL path encoding');
    }
    if (!seg || seg === '.' || seg === '..' || seg.includes('\0') || seg.includes('\\') || seg.includes('/')) {
      throw invalid('GitHub URL path contains invalid or traversal segments');
    }
    decoded.push(seg);
  }
  return decoded;
}

function assertOwnerRepo(owner: string, rawRepo: string): { owner: string; repo: string } {
  const repo = rawRepo.endsWith('.git') ? rawRepo.slice(0, -4) : rawRepo;
  if (!OWNER_RE.test(owner)) throw invalid(`Invalid GitHub owner '${owner}'`);
  if (!REPO_RE.test(repo) || repo === '.' || repo === '..') {
    throw invalid(`Invalid GitHub repository '${rawRepo}'`);
  }
  return { owner, repo };
}

export function parseGitHubSkillUrl(
  rawUrl: string,
  overrides?: { ref?: string; path?: string },
): ParsedGitHubSkillRef {
  const trimmed = rawUrl.trim();
  if (!trimmed) throw invalid('GitHub repository URL is required');
  if (/[\x00-\x20\x7f]/.test(trimmed)) {
    throw invalid('GitHub URL cannot contain whitespace or control characters');
  }
  if (/\\|%2e/i.test(trimmed) || /(?:^|\/)\.\.?(?:\/|$)/.test(trimmed.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]*/, ''))) {
    throw invalid('GitHub URL cannot contain dot-segment or backslash path traversal');
  }

  let owner: string;
  let repo: string;
  let ref: string | undefined;
  let path: string | undefined;

  if (!trimmed.includes('://')) {
    if (trimmed.startsWith('/') || trimmed.startsWith('.') || /[?:\\#@]/.test(trimmed)) {
      throw invalid('Enter an https://github.com/owner/repo URL or owner/repo shorthand');
    }
    const parts = trimmed.replace(/\/+$/, '').split('/');
    if (parts.length < 2) {
      throw invalid('GitHub shorthand must look like owner/repo');
    }
    ({ owner, repo } = assertOwnerRepo(parts[0]!, parts[1]!));
    path = sanitizeSubpath(parts.slice(2).join('/'));
  } else {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw invalid('Invalid GitHub URL');
    }
    if (parsed.protocol !== 'https:') {
      throw invalid('Only HTTPS GitHub URLs are allowed');
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.port) {
      throw invalid('GitHub URLs cannot contain credentials, ports, query strings, or fragments');
    }
    const host = parsed.hostname.toLowerCase();
    const segments = decodeSegments(parsed.pathname);

    if (host === 'github.com') {
      if (segments.length < 2) throw invalid('GitHub URL must include owner and repository');
      ({ owner, repo } = assertOwnerRepo(segments[0]!, segments[1]!));
      const rest = segments.slice(2);
      if (rest.length > 0) {
        if (rest[0] === 'tree') {
          if (rest.length < 2) throw invalid('GitHub /tree URL must specify a ref');
          ref = validateRef(rest[1]!);
          path = sanitizeSubpath(rest.slice(2).join('/'));
        } else if (rest[0] === 'blob') {
          if (rest.length < 3) throw invalid('GitHub /blob URL must specify a ref and file path');
          ref = validateRef(rest[1]!);
          const target = rest.slice(2);
          if (target[target.length - 1] === 'SKILL.md') target.pop();
          path = sanitizeSubpath(target.join('/'));
        } else {
          throw invalid(`Unsupported GitHub path '/${rest.join('/')}'`);
        }
      }
    } else if (host === 'raw.githubusercontent.com') {
      if (segments.length < 4) {
        throw invalid('raw.githubusercontent.com URL must include owner, repo, ref, and path');
      }
      ({ owner, repo } = assertOwnerRepo(segments[0]!, segments[1]!));
      ref = validateRef(segments[2]!);
      const target = segments.slice(3);
      if (target[target.length - 1] === 'SKILL.md') target.pop();
      path = sanitizeSubpath(target.join('/'));
    } else {
      throw invalid(`Unsupported host '${host}': only github.com and raw.githubusercontent.com are allowed`);
    }
  }

  if (overrides?.ref !== undefined && overrides.ref.trim() !== '') {
    ref = validateRef(overrides.ref);
  }
  if (overrides?.path !== undefined && overrides.path.trim() !== '') {
    path = sanitizeSubpath(overrides.path);
  }

  return {
    owner,
    repo,
    canonicalUrl: `https://github.com/${owner}/${repo}`,
    ...(ref ? { ref } : {}),
    ...(path ? { path } : {}),
  };
}

export function deriveRepoSourceName(parsed: ParsedGitHubSkillRef): string {
  if (parsed.path) {
    const tail = parsed.path.split('/').pop();
    if (tail) return tail;
  }
  return parsed.repo;
}

function concatBytes(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function readBoundedStream(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  overflowMessage: string,
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new GatewayError('UPSTREAM_ERROR', overflowMessage);
      }
      chunks.push(value);
    }
    return concatBytes(chunks, total);
  } finally {
    reader.releaseLock();
  }
}

function readTarString(block: Uint8Array, start: number, length: number): string {
  let end = start;
  const limit = start + length;
  while (end < limit && block[end] !== 0) end++;
  return decoder.decode(block.subarray(start, end));
}

function readTarSize(block: Uint8Array): number {
  const first = block[124] ?? 0;
  if ((first & 0x80) !== 0) {
    let size = first & 0x7f;
    for (let i = 125; i < 136; i++) {
      size = size * 256 + (block[i] ?? 0);
    }
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new GatewayError('UPSTREAM_ERROR', 'Repository archive contains invalid file size');
    }
    return size;
  }
  const raw = readTarString(block, 124, 12).trim();
  if (!raw) return 0;
  if (!/^[0-7]+$/.test(raw)) {
    throw new GatewayError('UPSTREAM_ERROR', 'Repository archive contains invalid octal size');
  }
  return Number.parseInt(raw, 8);
}

function parsePaxRecords(bytes: Uint8Array): Record<string, string> {
  const records: Record<string, string> = Object.create(null);
  let pos = 0;
  while (pos < bytes.byteLength) {
    const space = bytes.indexOf(0x20, pos);
    if (space === -1) break;
    const lenText = decoder.decode(bytes.subarray(pos, space));
    const recLen = Number.parseInt(lenText, 10);
    if (!Number.isFinite(recLen) || recLen <= 0 || pos + recLen > bytes.byteLength) break;
    const line = decoder.decode(bytes.subarray(space + 1, pos + recLen));
    const stripped = line.endsWith('\n') ? line.slice(0, -1) : line;
    const eq = stripped.indexOf('=');
    if (eq > 0) records[stripped.slice(0, eq)] = stripped.slice(eq + 1);
    pos += recLen;
  }
  return records;
}

export async function extractTarGz(
  compressed: Uint8Array,
  maxDecompressedBytes = MAX_DECOMPRESSED_BYTES,
): Promise<ExtractedTarFile[]> {
  if (compressed.byteLength === 0) {
    throw new GatewayError('UPSTREAM_ERROR', 'Repository archive is empty');
  }
  let tar: Uint8Array;
  try {
    const stream = new Response(Buffer.from(compressed)).body!.pipeThrough(
      new DecompressionStream('gzip'),
    );
    tar = await readBoundedStream(
      stream,
      maxDecompressedBytes,
      'Repository archive exceeds maximum allowed decompressed size',
    );
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw new GatewayError('UPSTREAM_ERROR', 'Failed to decompress GitHub repository archive', {
      cause: error,
    });
  }

  const files: ExtractedTarFile[] = [];
  let offset = 0;
  let nextPax: Record<string, string> | undefined;
  let nextLongName: string | undefined;

  while (offset + 512 <= tar.byteLength) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const headerSize = readTarSize(header);
    const typeFlag = header[156] === 0 ? '0' : String.fromCharCode(header[156]!);
    const dataStart = offset + 512;
    const paxSize = nextPax?.size !== undefined ? Number(nextPax.size) : undefined;
    const size = paxSize !== undefined && Number.isSafeInteger(paxSize) && paxSize >= 0 ? paxSize : headerSize;
    const dataEnd = dataStart + size;
    const paddedEnd = dataStart + Math.ceil(size / 512) * 512;
    if (paddedEnd > tar.byteLength) {
      throw new GatewayError('UPSTREAM_ERROR', 'Repository archive is truncated');
    }

    const payload = tar.subarray(dataStart, dataEnd);
    if (typeFlag === 'x') {
      nextPax = { ...(nextPax ?? {}), ...parsePaxRecords(payload) };
    } else if (typeFlag === 'L') {
      nextLongName = decoder.decode(payload).replace(/\0+$/, '');
    } else if (typeFlag === 'g') {
    } else {
      const paxPath = nextPax?.path;
      const longName = nextLongName;
      nextPax = undefined;
      nextLongName = undefined;

      if (typeFlag === '0') {
        const prefix = readTarString(header, 345, 155);
        const name = readTarString(header, 0, 100);
        const rawPath = (paxPath ?? longName ?? (prefix ? `${prefix}/${name}` : name)).replace(/^\/+/, '');
        const firstSlash = rawPath.indexOf('/');
        if (firstSlash !== -1) {
          const relPath = rawPath.slice(firstSlash + 1);
          if (relPath) {
            if (relPath.includes('\0') || relPath.includes('\\')) {
              throw new GatewayError('UPSTREAM_ERROR', 'Repository archive contains invalid file paths');
            }
            const parts = relPath.split('/');
            if (parts.some((part) => part === '..' || part === '.')) {
              throw new GatewayError('UPSTREAM_ERROR', 'Repository archive contains path traversal');
            }
            if (!parts.some((part) => IGNORED_DIRS.has(part))) {
              files.push({ path: parts.join('/'), bytes: payload });
            }
          }
        }
      }
    }
    offset = paddedEnd;
  }

  return files;
}

function unquoteYaml(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function fallbackFrontmatter(
  content: string,
  fallbackSlug: string,
): { slug: string; title: string; description: string; tags: string[]; frontmatter: Record<string, unknown> } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const fm: Record<string, unknown> = {};
  if (match) {
    const lines = match[1]!.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (!kv) continue;
      const [, key, rest] = kv;
      if (rest === '>' || rest === '|') {
        const block: string[] = [];
        while (i + 1 < lines.length && /^[ \t]+/.test(lines[i + 1]!)) {
          block.push(lines[++i]!.trim());
        }
        fm[key!] = block.join(rest === '>' ? ' ' : '\n').trim();
      } else if (rest === '' && i + 1 < lines.length && /^[ \t]+-\s+/.test(lines[i + 1]!)) {
        const arr: string[] = [];
        while (i + 1 < lines.length && /^[ \t]+-\s+(.*)$/.test(lines[i + 1]!)) {
          const item = lines[++i]!.match(/^[ \t]+-\s+(.*)$/);
          if (item) arr.push(unquoteYaml(item[1]!));
        }
        fm[key!] = arr;
      } else if (rest?.startsWith('[') && rest.endsWith(']')) {
        fm[key!] = rest
          .slice(1, -1)
          .split(',')
          .map((item) => unquoteYaml(item))
          .filter(Boolean);
      } else if (rest !== undefined) {
        fm[key!] = unquoteYaml(rest);
      }
    }
  }

  const body = match ? content.slice(match[0].length) : content;
  const firstParagraph =
    body
      .split(/\r?\n\s*\r?\n/)
      .map((p) => p.replace(/^#+\s+.*$/gm, '').trim())
      .find(Boolean)
      ?.replace(/\s+/g, ' ')
      .slice(0, 280) ?? '';

  const name = typeof fm.name === 'string' && fm.name.trim() ? fm.name.trim() : fallbackSlug;
  const title = typeof fm.title === 'string' && fm.title.trim() ? fm.title.trim() : name;
  const description =
    typeof fm.description === 'string' && fm.description.trim()
      ? fm.description.trim()
      : firstParagraph || `Skill ${title}`;
  const tags = Array.isArray(fm.tags)
    ? fm.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0)
    : [];

  return { slug: name, title, description, tags, frontmatter: { ...fm, name, description } };
}

function normalizeSlug(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120);
  return cleaned || 'skill';
}

function owningSkillDir(filePath: string, skillDirs: Set<string>): string | undefined {
  let cursor = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '';
  for (;;) {
    if (skillDirs.has(cursor)) return cursor;
    if (!cursor) return undefined;
    const slash = cursor.lastIndexOf('/');
    cursor = slash === -1 ? '' : cursor.slice(0, slash);
  }
}

function encodeGitHubRef(ref: string): string {
  return ref.split('/').map((part) => encodeURIComponent(part)).join('/');
}

function isAllowedRedirectHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === 'codeload.github.com' || lower.endsWith('.githubusercontent.com');
}

class ArchiveOverflowError extends GatewayError {
  constructor(message: string) {
    super('UPSTREAM_ERROR', message);
  }
}

async function mapGitHubHttpFailure(response: Response, contextLabel: string): Promise<never> {
  await response.body?.cancel().catch(() => {});
  if (response.status === 401 || response.status === 403) {
    throw new GatewayError(
      'AUTH_REQUIRED',
      'GitHub repository requires credentials or rejected the configured token',
    );
  }
  if (response.status === 404) {
    throw new GatewayError('UPSTREAM_ERROR', 'GitHub repository or ref not found');
  }
  if (response.status === 429) {
    throw new GatewayError(
      'UPSTREAM_ERROR',
      'GitHub rate limit reached; retry later or attach a GitHub token secret',
    );
  }
  throw new GatewayError('UPSTREAM_ERROR', `${contextLabel} failed with HTTP ${response.status}`);
}

async function fetchOrThrow(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMessage: string,
): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    const err = error as { name?: string };
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new GatewayError('UPSTREAM_TIMEOUT', timeoutMessage, { cause: error });
    }
    throw new GatewayError('UPSTREAM_ERROR', 'Failed to reach GitHub repository', { cause: error });
  }
}

async function downloadTarball(
  parsed: ParsedGitHubSkillRef,
  options: { bearerToken?: string; fetchImpl: typeof fetch; timeoutMs: number },
): Promise<Uint8Array> {
  const ref = encodeGitHubRef(parsed.ref ?? 'HEAD');
  const signal = AbortSignal.timeout(options.timeoutMs);
  const headers: Record<string, string> = { 'user-agent': 'AgentFabric/0.1.0' };

  let response: Response;
  if (options.bearerToken) {
    response = await fetchOrThrow(
      options.fetchImpl,
      `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/tarball/${ref}`,
      {
        headers: {
          ...headers,
          authorization: `Bearer ${options.bearerToken}`,
          accept: 'application/vnd.github+json',
        },
        redirect: 'manual',
        signal,
      },
      'Timed out downloading GitHub repository',
    );
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      if (!location) {
        throw new GatewayError('UPSTREAM_ERROR', 'GitHub archive redirect did not include a location');
      }
      let target: URL;
      try {
        target = new URL(location);
      } catch {
        throw new GatewayError('UPSTREAM_ERROR', 'GitHub returned an invalid archive redirect URL');
      }
      if (target.protocol !== 'https:' || !isAllowedRedirectHost(target.hostname)) {
        throw new GatewayError('UPSTREAM_ERROR', 'Refused redirect outside GitHub archive hosts');
      }
      response = await fetchOrThrow(
        options.fetchImpl,
        target.href,
        { headers, redirect: 'error', signal },
        'Timed out downloading GitHub repository',
      );
    }
  } else {
    response = await fetchOrThrow(
      options.fetchImpl,
      `https://codeload.github.com/${parsed.owner}/${parsed.repo}/tar.gz/${ref}`,
      { headers, redirect: 'error', signal },
      'Timed out downloading GitHub repository',
    );
  }

  if (!response.ok || !response.body) {
    return mapGitHubHttpFailure(response, 'GitHub archive request');
  }

  const lengthHeader = response.headers.get('content-length');
  if (lengthHeader && Number(lengthHeader) > MAX_DOWNLOAD_BYTES) {
    await response.body.cancel().catch(() => {});
    throw new ArchiveOverflowError('GitHub repository archive exceeds maximum download size');
  }

  try {
    return await readBoundedStream(
      response.body,
      MAX_DOWNLOAD_BYTES,
      'GitHub repository archive exceeds maximum download size',
    );
  } catch (error) {
    if (error instanceof GatewayError && error.message.includes('exceeds maximum')) {
      throw new ArchiveOverflowError(error.message);
    }
    throw error;
  }
}

function safeTreePath(rawPath: string): string | undefined {
  const cleaned = rawPath.replace(/^\/+/, '');
  if (!cleaned || cleaned.includes('\0') || cleaned.includes('\\')) return undefined;
  const parts = cleaned.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..' || IGNORED_DIRS.has(part))) {
    return undefined;
  }
  return parts.join('/');
}

async function fetchViaGitTrees(
  parsed: ParsedGitHubSkillRef,
  config: SkillRepoSourceConfig,
  options: { bearerToken?: string; fetchImpl: typeof fetch; timeoutMs: number },
): Promise<DiscoveredRepoSkill[]> {
  const treeRef = parsed.ref ?? 'HEAD';
  const ref = encodeGitHubRef(treeRef);
  const headers: Record<string, string> = {
    'user-agent': 'AgentFabric/0.1.0',
    accept: 'application/vnd.github+json',
    ...(options.bearerToken ? { authorization: `Bearer ${options.bearerToken}` } : {}),
  };
  const treeRes = await fetchOrThrow(
    options.fetchImpl,
    `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/git/trees/${ref}?recursive=1`,
    { headers, redirect: 'error', signal: AbortSignal.timeout(options.timeoutMs) },
    'Timed out querying GitHub repository tree',
  );
  if (!treeRes.ok) {
    return mapGitHubHttpFailure(treeRes, 'GitHub tree request');
  }

  let payload: {
    truncated?: unknown;
    tree?: Array<{ path?: unknown; type?: unknown; mode?: unknown; size?: unknown }>;
  };
  try {
    payload = (await treeRes.json()) as typeof payload;
  } catch (error) {
    throw new GatewayError('UPSTREAM_ERROR', 'GitHub returned invalid tree metadata', { cause: error });
  }

  if (payload.truncated === true) {
    throw new GatewayError(
      'UPSTREAM_ERROR',
      "GitHub truncated the repository tree listing; set 'path' to a narrower skills directory",
    );
  }

  const blobEntries: Array<{ path: string; size?: number }> = [];
  for (const item of Array.isArray(payload.tree) ? payload.tree : []) {
    if (item?.type !== 'blob' || typeof item.path !== 'string' || item.mode === SYMLINK_MODE) continue;
    const safe = safeTreePath(item.path);
    if (!safe) continue;
    if (parsed.path && safe !== parsed.path && !safe.startsWith(`${parsed.path}/`)) continue;
    blobEntries.push({
      path: safe,
      ...(typeof item.size === 'number' && Number.isFinite(item.size) ? { size: item.size } : {}),
    });
  }

  let skillBlobs = blobEntries.filter(
    (entry) => entry.path === 'SKILL.md' || entry.path.endsWith('/SKILL.md'),
  );
  if (skillBlobs.length === 0) {
    throw new GatewayError('UPSTREAM_ERROR', 'No SKILL.md files found in the GitHub repository');
  }

  if (skillBlobs.length > MAX_SPARSE_FILE_FETCHES && config.includeSkills?.length) {
    const includeSet = new Set(config.includeSkills.map((slug) => normalizeSlug(slug)));
    const filtered = skillBlobs.filter((entry) => {
      const dir = entry.path === 'SKILL.md' ? '' : entry.path.slice(0, -'/SKILL.md'.length);
      const dirSlug = dir ? dir.split('/').pop()! : parsed.repo;
      return includeSet.has(normalizeSlug(dirSlug));
    });
    if (filtered.length > 0) skillBlobs = filtered;
  }

  if (skillBlobs.length > MAX_SPARSE_FILE_FETCHES) {
    throw new GatewayError(
      'UPSTREAM_ERROR',
      `Large repository contains ${skillBlobs.length} skills (sparse limit ${MAX_SPARSE_FILE_FETCHES}); set 'path' or 'includeSkills' to narrow it`,
    );
  }

  for (const blob of skillBlobs) {
    if (blob.size !== undefined && blob.size > MAX_SKILL_MD_BYTES) {
      throw new GatewayError('UPSTREAM_ERROR', `Skill file '${blob.path}' exceeds 256 KiB limit`);
    }
  }

  const skillDirs = new Set(
    skillBlobs.map((file) => (file.path === 'SKILL.md' ? '' : file.path.slice(0, -'/SKILL.md'.length))),
  );
  const siblingBlobsByDir = new Map<string, Array<{ path: string; size?: number }>>();
  for (const blob of blobEntries) {
    if (blob.path === 'SKILL.md' || blob.path.endsWith('/SKILL.md')) continue;
    const ownerDir = owningSkillDir(blob.path, skillDirs);
    if (ownerDir === undefined) continue;
    if (blob.size !== undefined && blob.size > MAX_SIBLING_FILE_BYTES) continue;
    const list = siblingBlobsByDir.get(ownerDir);
    if (list) list.push(blob);
    else siblingBlobsByDir.set(ownerDir, [blob]);
  }

  const selectedBlobs: Array<{ path: string; maxBytes: number }> = skillBlobs.map((blob) => ({
    path: blob.path,
    maxBytes: MAX_SKILL_MD_BYTES,
  }));
  for (const dir of [...skillDirs].sort()) {
    const candidates = (siblingBlobsByDir.get(dir) ?? []).sort((a, b) => a.path.localeCompare(b.path));
    let count = 0;
    let totalBytes = 0;
    for (const sibling of candidates) {
      if (selectedBlobs.length >= MAX_SPARSE_FILE_FETCHES) break;
      if (count >= MAX_SIBLING_FILES_PER_SKILL) break;
      const estimated = sibling.size ?? 0;
      if (totalBytes + estimated > MAX_SIBLING_TOTAL_BYTES) continue;
      selectedBlobs.push({ path: sibling.path, maxBytes: MAX_SIBLING_FILE_BYTES });
      count++;
      totalBytes += estimated;
    }
  }

  const extracted: ExtractedTarFile[] = [];

  for (const item of selectedBlobs) {
    const encodedPath = encodeGitHubRef(item.path);
    const blobUrl = options.bearerToken
      ? `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/contents/${encodedPath}?ref=${encodeURIComponent(treeRef)}`
      : `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${ref}/${encodedPath}`;
    const blobHeaders: Record<string, string> = {
      'user-agent': 'AgentFabric/0.1.0',
      ...(options.bearerToken
        ? {
            authorization: `Bearer ${options.bearerToken}`,
            accept: 'application/vnd.github.raw+json',
          }
        : {}),
    };
    const res = await fetchOrThrow(
      options.fetchImpl,
      blobUrl,
      { headers: blobHeaders, redirect: 'error', signal: AbortSignal.timeout(options.timeoutMs) },
      'Timed out downloading skill file from GitHub',
    );
    if (!res.ok || !res.body) {
      return mapGitHubHttpFailure(res, `GitHub file fetch (${item.path})`);
    }
    const bytes = await readBoundedStream(
      res.body,
      item.maxBytes,
      `Skill file '${item.path}' exceeds ${Math.round(item.maxBytes / 1024)} KiB limit`,
    );
    extracted.push({ path: item.path, bytes });
  }

  return discoverSkillsFromFiles(extracted, parsed, config);
}

async function discoverSkillsFromFiles(
  allFiles: ExtractedTarFile[],
  parsed: ParsedGitHubSkillRef,
  config: SkillRepoSourceConfig,
): Promise<DiscoveredRepoSkill[]> {
  const scopedFiles = parsed.path
    ? allFiles.filter((file) => file.path === parsed.path || file.path.startsWith(`${parsed.path}/`))
    : allFiles;

  const skillMdFiles = scopedFiles.filter(
    (file) => file.path === 'SKILL.md' || file.path.endsWith('/SKILL.md'),
  );
  if (skillMdFiles.length === 0) {
    throw new GatewayError('UPSTREAM_ERROR', 'No SKILL.md files found in the GitHub repository');
  }

  const skillDirs = new Set(
    skillMdFiles.map((file) => (file.path === 'SKILL.md' ? '' : file.path.slice(0, -'/SKILL.md'.length))),
  );
  const filesBySkillDir = new Map<string, ExtractedTarFile[]>();
  for (const file of scopedFiles) {
    if (file.path === 'SKILL.md' || file.path.endsWith('/SKILL.md')) continue;
    const ownerDir = owningSkillDir(file.path, skillDirs);
    if (ownerDir === undefined) continue;
    const bucket = filesBySkillDir.get(ownerDir);
    if (bucket) bucket.push(file);
    else filesBySkillDir.set(ownerDir, [file]);
  }

  const includeSet = config.includeSkills?.length
    ? new Set(config.includeSkills.map((slug) => normalizeSlug(slug)))
    : undefined;
  const repoTags = config.tags ?? [];

  const candidates: Array<DiscoveredRepoSkill & { candidateSlug: string }> = [];
  for (const file of skillMdFiles) {
    if (file.bytes.byteLength > MAX_SKILL_MD_BYTES) {
      throw new GatewayError('UPSTREAM_ERROR', `Skill file '${file.path}' exceeds 256 KiB limit`);
    }
    const skillDir = file.path === 'SKILL.md' ? '' : file.path.slice(0, -'/SKILL.md'.length);
    const dirSlug = skillDir ? skillDir.split('/').pop()! : parsed.repo;
    const content = decoder.decode(file.bytes);
    const parsedMeta = fallbackFrontmatter(content, dirSlug);

    let frontmatter = parsedMeta.frontmatter;
    let rawSlug = parsedMeta.slug;
    let description = parsedMeta.description;
    let title = parsedMeta.title;
    try {
      const entry = await sdkSkillEntry(dirSlug, { 'SKILL.md': content }, { baseUri: 'skill://' });
      frontmatter = { ...entry.frontmatter };
      rawSlug = String(entry.frontmatter.name || dirSlug);
      description = String(entry.frontmatter.description || parsedMeta.description);
      title =
        typeof entry.frontmatter.title === 'string' && entry.frontmatter.title.trim()
          ? entry.frontmatter.title.trim()
          : parsedMeta.title !== dirSlug
            ? parsedMeta.title
            : rawSlug;
    } catch {
    }

    const candidateSlug = normalizeSlug(rawSlug);
    if (includeSet && !includeSet.has(candidateSlug) && !includeSet.has(normalizeSlug(dirSlug))) {
      continue;
    }

    const siblingFiles: Record<string, string> = {};
    const candidatesForDir = (filesBySkillDir.get(skillDir) ?? []).sort((a, b) =>
      a.path.localeCompare(b.path),
    );
    let siblingCount = 0;
    let siblingBytes = 0;
    for (const sibling of candidatesForDir) {
      const rel = skillDir ? sibling.path.slice(skillDir.length + 1) : sibling.path;
      if (!rel || rel.includes('..') || sibling.bytes.includes(0)) continue;
      if (sibling.bytes.byteLength > MAX_SIBLING_FILE_BYTES) continue;
      if (siblingCount >= MAX_SIBLING_FILES_PER_SKILL) break;
      if (siblingBytes + sibling.bytes.byteLength > MAX_SIBLING_TOTAL_BYTES) continue;
      const text = decodeText(sibling.bytes);
      if (text === undefined) continue;
      siblingFiles[rel] = text;
      siblingCount++;
      siblingBytes += sibling.bytes.byteLength;
    }

    const tags = [...new Set([...repoTags, ...parsedMeta.tags])];
    candidates.push({
      candidateSlug,
      slug: candidateSlug,
      title,
      description,
      content,
      frontmatter,
      files: siblingFiles,
      tags,
      sourcePath: file.path,
    });
  }

  if (candidates.length === 0) {
    throw new GatewayError('UPSTREAM_ERROR', 'No matching skills found in the GitHub repository');
  }
  if (candidates.length > MAX_SKILLS_PER_REPO) {
    throw new GatewayError(
      'UPSTREAM_ERROR',
      `Repository contains ${candidates.length} skills, exceeding the ${MAX_SKILLS_PER_REPO} limit; set 'path' or 'includeSkills' to narrow it`,
    );
  }

  candidates.sort((a, b) => a.candidateSlug.localeCompare(b.candidateSlug) || a.sourcePath.localeCompare(b.sourcePath));
  const usedSlugs = new Set<string>();
  return candidates.map(({ candidateSlug, ...rest }) => {
    let slug = candidateSlug;
    let suffix = 2;
    while (usedSlugs.has(slug)) {
      slug = `${candidateSlug}-${suffix++}`;
    }
    usedSlugs.add(slug);
    return { ...rest, slug };
  });
}

export async function fetchGitHubSkills(
  config: SkillRepoSourceConfig,
  options: { bearerToken?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<DiscoveredRepoSkill[]> {
  const parsed = parseGitHubSkillUrl(config.url, { ref: config.ref, path: config.path });
  const opts = {
    bearerToken: options.bearerToken,
    fetchImpl: options.fetchImpl ?? fetch,
    timeoutMs: options.timeoutMs ?? 25_000,
  };

  try {
    const compressed = await downloadTarball(parsed, opts);
    const allFiles = await extractTarGz(compressed, MAX_DECOMPRESSED_BYTES);
    return await discoverSkillsFromFiles(allFiles, parsed, config);
  } catch (error) {
    if (
      error instanceof ArchiveOverflowError ||
      (error instanceof GatewayError &&
        error.code === 'UPSTREAM_ERROR' &&
        error.message.includes('maximum allowed decompressed size'))
    ) {
      return fetchViaGitTrees(parsed, config, opts);
    }
    throw error;
  }
}
