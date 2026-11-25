import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const commentFreeRoots = ['src', 'web/src', 'tests'];
const allowedDocs = ['AGENTS.md', 'README.md', 'STRATEGY.md'];
const skippedDocDirs = new Set(['node_modules', 'dist', '.git', '.cloudflare', '.claude/skills']);
const keywordsBeforeExpression = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

function listFiles(dir: string, accept: (file: string) => boolean, skip: (relative: string) => boolean = () => false): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const relative = path.relative(repoRoot, full);
    if (entry.name === 'node_modules' || skip(relative)) continue;
    if (entry.isDirectory()) files.push(...listFiles(full, accept, skip));
    else if (accept(full)) files.push(full);
  }
  return files;
}

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index++) if (text[index] === '\n') line++;
  return line;
}

function findScriptComments(text: string): number[] {
  const offsets: number[] = [];
  const braces: Array<'brace' | 'template'> = [];
  const length = text.length;
  let index = 0;
  let valueEnded = false;
  let previous = '';

  const readTemplate = (): void => {
    while (index < length) {
      const char = text[index];
      if (char === '\\') {
        index += 2;
        continue;
      }
      if (char === '`') {
        index++;
        valueEnded = true;
        return;
      }
      if (char === '$' && text[index + 1] === '{') {
        index += 2;
        braces.push('template');
        valueEnded = false;
        return;
      }
      index++;
    }
  };

  while (index < length) {
    const char = text[index];
    const next = text[index + 1];
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      index++;
      continue;
    }
    if (char === '/' && next === '/' && text[index - 1] === ':') {
      index += 2;
      valueEnded = false;
      previous = '/';
      continue;
    }
    if (char === '/' && next === '/') {
      offsets.push(index);
      while (index < length && text[index] !== '\n') index++;
      continue;
    }
    if (char === '/' && next === '*') {
      offsets.push(index);
      const end = text.indexOf('*/', index + 2);
      index = end === -1 ? length : end + 2;
      continue;
    }
    if (char === '"' || char === "'") {
      index++;
      while (index < length && text[index] !== char && text[index] !== '\n') {
        if (text[index] === '\\') index++;
        index++;
      }
      index++;
      valueEnded = true;
      previous = char;
      continue;
    }
    if (char === '`') {
      index++;
      readTemplate();
      previous = '`';
      continue;
    }
    if (char === '/') {
      if (valueEnded || previous === '<') {
        index++;
        valueEnded = false;
        previous = '/';
        continue;
      }
      index++;
      let inClass = false;
      while (index < length && text[index] !== '\n') {
        const regexChar = text[index];
        if (regexChar === '\\') {
          index += 2;
          continue;
        }
        if (regexChar === '[') inClass = true;
        else if (regexChar === ']') inClass = false;
        else if (regexChar === '/' && !inClass) break;
        index++;
      }
      index++;
      while (index < length && /[A-Za-z0-9_$]/.test(text[index])) index++;
      valueEnded = true;
      previous = '/';
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      const start = index;
      while (index < length && /[A-Za-z0-9_$]/.test(text[index])) index++;
      valueEnded = !keywordsBeforeExpression.has(text.slice(start, index));
      previous = 'a';
      continue;
    }
    if (/[0-9]/.test(char)) {
      while (index < length && /[0-9A-Za-z_.]/.test(text[index])) index++;
      valueEnded = true;
      previous = '0';
      continue;
    }
    if (char === '{') {
      braces.push('brace');
      valueEnded = false;
      previous = char;
      index++;
      continue;
    }
    if (char === '}') {
      const top = braces.pop();
      index++;
      previous = char;
      if (top === 'template') {
        readTemplate();
        previous = '`';
      } else {
        valueEnded = true;
      }
      continue;
    }
    valueEnded = char === ')' || char === ']';
    previous = char;
    index++;
  }
  return offsets;
}

function findCssComments(text: string): number[] {
  const offsets: number[] = [];
  let index = 0;
  let quote: string | undefined;
  while (index < text.length) {
    const char = text[index];
    if (quote) {
      if (char === '\\') index++;
      else if (char === quote || char === '\n') quote = undefined;
      index++;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      index++;
      continue;
    }
    if (char === '/' && text[index + 1] === '*') {
      offsets.push(index);
      const end = text.indexOf('*/', index + 2);
      index = end === -1 ? text.length : end + 2;
      continue;
    }
    index++;
  }
  return offsets;
}

function collectViolations(files: string[], find: (text: string) => number[]): string[] {
  return files.flatMap((file) => {
    const text = readFileSync(file, 'utf8');
    return find(text).map((offset) => `${path.relative(repoRoot, file)}:${lineOf(text, offset)}`);
  });
}

function sourceRoots(extensions: RegExp): string[] {
  return commentFreeRoots.flatMap((root) =>
    listFiles(path.join(repoRoot, root), (file) => extensions.test(file)),
  );
}

describe('repository hygiene', () => {
  it('keeps comment detection honest on tricky sources', () => {
    const tricky = [
      "const url = 'https://example.com/a//b';",
      'const pattern = /foo\\/bar\\/\\/baz/g;',
      'const half = total / 2 / 3;',
      'const text = `https://${host}/path // not a comment`;',
      'const nested = `a ${`b ${c} //`} d`;',
      'const jsx = <a href="x">skill://</a>;',
    ].join('\n');
    expect(findScriptComments(tricky)).toEqual([]);
    expect(findScriptComments('const a = 1; // trailing')).toEqual([13]);
    expect(findScriptComments('/* lead */\nconst a = 1;')).toEqual([0]);
    expect(findScriptComments('const a = <b>{/* x */}</b>;')).toHaveLength(1);
    expect(findCssComments('a { content: "/* kept */"; } /* gone */')).toEqual([29]);
  });

  it('keeps src, web/src, and tests free of script comments', () => {
    const files = sourceRoots(/\.(tsx?|mjs|cjs|js)$/);
    expect(files.length).toBeGreaterThan(0);
    expect(collectViolations(files, findScriptComments)).toEqual([]);
  });

  it('keeps web/src free of CSS comments', () => {
    const files = listFiles(path.join(repoRoot, 'web/src'), (file) => file.endsWith('.css'));
    expect(files.length).toBeGreaterThan(0);
    expect(collectViolations(files, findCssComments)).toEqual([]);
  });

  it('keeps documentation to the root-level tidy set', () => {
    const docs = listFiles(
      repoRoot,
      (file) => /\.(md|txt)$/.test(file),
      (relative) => skippedDocDirs.has(relative),
    ).map((file) => path.relative(repoRoot, file));
    expect(docs.filter((doc) => !allowedDocs.includes(doc))).toEqual([]);
  });
});
