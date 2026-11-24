import { constants } from 'node:fs';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { GatewayError, type SharedFolderSourceConfig } from '../types/index.js';

export const filePathSchema = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };
const outside = () => new GatewayError('PATH_OUTSIDE_SHARE', 'Path is outside the shared folder');
const permitted = (config: SharedFolderSourceConfig, name: string) => !config.allowedExtensions?.length ||
  config.allowedExtensions.some(extension => extname(name).toLowerCase() === (extension.startsWith('.') ? extension : '.' + extension).toLowerCase());

function within(root: string, path: string) {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}

const privateState = /^(master\.key|secrets\.enc|state\.db|traces\.duckdb|operator-token)(?:$|[.-])/;
function privatePath(home: string | undefined, path: string) {
  if (!home || !within(home, path)) return false;
  return privateState.test(relative(home, path).split(sep)[0]);
}

async function confined(config: SharedFolderSourceConfig, rel: string, protectedHome?: string) {
  if (rel.includes('\0') || rel.includes('\\') || isAbsolute(rel) || rel.split('/').includes('..')) throw outside();
  const root = await realpath(config.rootPath);
  const path = await realpath(resolve(root, rel)).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === 'ELOOP') throw outside();
    throw new GatewayError('NOT_FOUND', 'Shared path does not exist', { cause });
  });
  if (!within(root, path)) throw outside();
  const home = protectedHome && await realpath(protectedHome).catch(() => undefined);
  if (privatePath(home, path)) throw new GatewayError('FORBIDDEN', 'Gateway state files are private');
  return { root, path, home };
}

export function shareUri(config: SharedFolderSourceConfig, rel = '') {
  return `workspace://${config.shareName}/${rel.split('/').map(encodeURIComponent).join('/')}`;
}

export function sharePath(config: SharedFolderSourceConfig, uri: string) {
  const prefix = shareUri(config);
  if (!uri.startsWith(prefix)) throw outside();
  try { return decodeURIComponent(uri.slice(prefix.length)); }
  catch { throw new GatewayError('INVALID_INPUT', 'Invalid shared resource URI'); }
}

export async function listShare(config: SharedFolderSourceConfig, rel = '', protectedHome?: string) {
  const { root, path, home } = await confined(config, rel, protectedHome);
  const directory = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  try {
    const active = process.platform === 'linux' ? `/proc/self/fd/${directory.fd}` : path;
    const canonical = await realpath(active);
    if (!within(root, canonical)) throw outside();
    if (privatePath(home, canonical)) throw new GatewayError('FORBIDDEN', 'Gateway state files are private');
    const entries = await readdir(active, { withFileTypes: true });
    return entries.filter(entry => !privatePath(home, resolve(canonical, entry.name)) &&
      (entry.isDirectory() || (entry.isFile() && permitted(config, entry.name)))).map(entry => {
      const child = [rel, entry.name].filter(Boolean).join('/');
      return { name: entry.name, path: child, uri: shareUri(config, child), kind: entry.isDirectory() ? 'directory' : 'file' };
    }).sort((a, b) => a.name.localeCompare(b.name));
  } finally { await directory.close(); }
}

export async function readShare(config: SharedFolderSourceConfig, rel: string, protectedHome?: string) {
  const { root, path, home } = await confined(config, rel, protectedHome);
  if (!permitted(config, rel) || !permitted(config, path)) throw new GatewayError('FORBIDDEN', 'File extension is excluded from the shared folder');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const active = process.platform === 'linux' ? `/proc/self/fd/${handle.fd}` : path;
    const canonical = await realpath(active);
    if (!within(root, canonical)) throw outside();
    if (privatePath(home, canonical)) throw new GatewayError('FORBIDDEN', 'Gateway state files are private');
    const info = await handle.stat();
    const limit = config.maxFileBytes ?? 1024 * 1024;
    if (!info.isFile()) throw new GatewayError('INVALID_INPUT', 'Shared path must be a regular file');
    if (info.size > limit) throw new GatewayError('INVALID_INPUT', 'Shared file exceeds byte limit');
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= limit) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, limit - total + 1));
      const { bytesRead } = await handle.read(buffer);
      if (!bytesRead) break;
      chunks.push(buffer.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > limit) throw new GatewayError('INVALID_INPUT', 'Shared file exceeds byte limit');
    const contents = Buffer.concat(chunks);
    try { return { mimeType: 'text/plain', text: new TextDecoder('utf-8', { fatal: true }).decode(contents) }; }
    catch { return { mimeType: 'application/octet-stream', blob: contents.toString('base64') }; }
  } finally { await handle.close(); }
}

export async function checkShare(config: SharedFolderSourceConfig) {
  if (!(await stat(await realpath(config.rootPath))).isDirectory()) throw new GatewayError('INVALID_INPUT', 'Share root must be a directory');
}
