import { afterEach, describe, expect, it, vi } from 'vitest';
import { gzipSync } from 'node:zlib';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  GetSkillResultSchema,
  ListSkillsResultSchema,
  ReadResourceDirectoryResultSchema,
} from '@modelcontextprotocol/core/ext/skills';
import { createGatewayRuntime } from '../../src/runtime/index.js';
import { MemoryTraceStore } from '../../src/storage/memory.js';
import { MAX_DOWNLOAD_BYTES, fetchGitHubSkills, parseGitHubSkillUrl } from '../../src/upstreams/github-skills.js';

const temps: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  while (temps.length) await rm(temps.pop()!, { recursive: true, force: true });
});

function writeOctal(buf: Uint8Array, offset: number, length: number, value: number) {
  const oct = value.toString(8).padStart(length - 1, '0');
  buf.set(Buffer.from(oct, 'ascii'), offset);
  buf[offset + length - 1] = 0;
}

function buildTarGz(entries: Array<{ path: string; content: string | Uint8Array; type?: '0' | '2' }>): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const entry of entries) {
    const data = typeof entry.content === 'string' ? Buffer.from(entry.content, 'utf8') : entry.content;
    const rawPath = entry.path;

    if (Buffer.byteLength(rawPath) > 95) {
      const recBody = `path=${rawPath}\n`;
      let totalLen = Buffer.byteLength(recBody) + 3;
      for (;;) {
        const line = `${totalLen} ${recBody}`;
        if (Buffer.byteLength(line) === totalLen) break;
        totalLen = Buffer.byteLength(line);
      }
      const paxPayload = Buffer.from(`${totalLen} ${recBody}`, 'utf8');
      const paxHeader = new Uint8Array(512);
      paxHeader.set(Buffer.from('paxheader', 'ascii'), 0);
      writeOctal(paxHeader, 100, 8, 0o644);
      writeOctal(paxHeader, 124, 12, paxPayload.byteLength);
      paxHeader[156] = 'x'.charCodeAt(0);
      paxHeader.set(Buffer.from('ustar\0', 'ascii'), 257);
      paxHeader.set(Buffer.from('00', 'ascii'), 263);
      paxHeader.fill(0x20, 148, 156);
      const sum = paxHeader.reduce((a, b) => a + b, 0);
      writeOctal(paxHeader, 148, 8, sum);
      blocks.push(paxHeader);
      const paxPadded = new Uint8Array(Math.ceil(paxPayload.byteLength / 512) * 512);
      paxPadded.set(paxPayload, 0);
      blocks.push(paxPadded);
    }

    const header = new Uint8Array(512);
    header.set(Buffer.from(rawPath.slice(0, 99), 'ascii'), 0);
    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, data.byteLength);
    writeOctal(header, 136, 12, 1700000000);
    header[156] = (entry.type ?? '0').charCodeAt(0);
    header.set(Buffer.from('ustar\0', 'ascii'), 257);
    header.set(Buffer.from('00', 'ascii'), 263);
    header.fill(0x20, 148, 156);
    const checksum = header.reduce((a, b) => a + b, 0);
    writeOctal(header, 148, 8, checksum);
    blocks.push(header);

    const paddedLen = Math.ceil(data.byteLength / 512) * 512;
    if (paddedLen > 0) {
      const padded = new Uint8Array(paddedLen);
      padded.set(data, 0);
      blocks.push(padded);
    }
  }
  blocks.push(new Uint8Array(1024));
  const tar = Buffer.concat(blocks);
  return new Uint8Array(gzipSync(tar));
}

describe('parseGitHubSkillUrl', () => {
  it('parses repo, tree, blob SKILL.md, raw.githubusercontent.com, and owner/repo shorthand', () => {
    expect(parseGitHubSkillUrl('https://github.com/kunchenguid/vision/')).toEqual({
      owner: 'kunchenguid',
      repo: 'vision',
      canonicalUrl: 'https://github.com/kunchenguid/vision',
    });
    expect(parseGitHubSkillUrl('https://github.com/owner/repo.git')).toEqual({
      owner: 'owner',
      repo: 'repo',
      canonicalUrl: 'https://github.com/owner/repo',
    });
    expect(parseGitHubSkillUrl('https://github.com/kunchenguid/vision/tree/main/skills/vision')).toEqual({
      owner: 'kunchenguid',
      repo: 'vision',
      canonicalUrl: 'https://github.com/kunchenguid/vision',
      ref: 'main',
      path: 'skills/vision',
    });
    expect(parseGitHubSkillUrl('https://github.com/kunchenguid/vision/blob/main/skills/vision/SKILL.md')).toEqual({
      owner: 'kunchenguid',
      repo: 'vision',
      canonicalUrl: 'https://github.com/kunchenguid/vision',
      ref: 'main',
      path: 'skills/vision',
    });
    expect(parseGitHubSkillUrl('https://raw.githubusercontent.com/kunchenguid/vision/main/skills/vision/SKILL.md')).toEqual({
      owner: 'kunchenguid',
      repo: 'vision',
      canonicalUrl: 'https://github.com/kunchenguid/vision',
      ref: 'main',
      path: 'skills/vision',
    });
    expect(parseGitHubSkillUrl('michael-denyer/pstack-claude/plugins/pstack')).toEqual({
      owner: 'michael-denyer',
      repo: 'pstack-claude',
      canonicalUrl: 'https://github.com/michael-denyer/pstack-claude',
      path: 'plugins/pstack',
    });
  });

  it('fails closed on non-HTTPS, SSRF hosts, embedded credentials, and path traversal', () => {
    for (const bad of [
      '',
      'http://github.com/a/b',
      'file:///etc/passwd',
      'https://127.0.0.1/a/b',
      'https://evil.example/a/b',
      'https://user:pass@github.com/a/b',
      'https://github.com/a/b?token=x',
      'https://github.com/a/b/tree/main/%2e%2e/secret',
      'https://github.com/a/b/issues/12',
    ]) {
      expect(() => parseGitHubSkillUrl(bad)).toThrowError(/Invalid|HTTPS|Unsupported|credentials|required|traversal/i);
    }
  });
});

describe('fetchGitHubSkills & runtime MCP integration', () => {
  const visionMd = '---\nname: vision\ndescription: >\n  Draft and stress-test\n  a repository vision.\n---\n# /vision\nEvidence over vibes.';
  const potetoMd = '---\nname: poteto-mode\ndescription: Rigorous agent workflow.\n---\n# Poteto mode\nKeep it simple.';

  it('extracts multi-skill repos, PAX paths, and sibling assets while skipping binaries and symlinks', async () => {
    const tarball = buildTarGz([
      { path: 'repo-HEAD/skills/vision/SKILL.md', content: visionMd },
      { path: 'repo-HEAD/skills/vision/assets/review-template.html', content: '<html><body>Board</body></html>' },
      { path: 'repo-HEAD/skills/vision/assets/review.css', content: 'body { color: #111; }' },
      { path: 'repo-HEAD/skills/vision/assets/binary.png', content: new Uint8Array([0x89, 0x50, 0x00, 0x47]) },
      { path: 'repo-HEAD/plugins/very-long-nested-folder-for-pax-header-coverage/skills/poteto-mode/SKILL.md', content: potetoMd },
      { path: 'repo-HEAD/plugins/very-long-nested-folder-for-pax-header-coverage/skills/poteto-mode/symlink', content: '/etc/passwd', type: '2' },
    ]);
    const fetchMock = vi.fn(async () => new Response(Buffer.from(tarball), { status: 200 }));
    const skills = await fetchGitHubSkills(
      { kind: 'skill_repo', url: 'https://github.com/example/collection', tags: ['imported'] },
      { fetchImpl: fetchMock as unknown as typeof fetch },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(skills.map((s) => s.slug)).toEqual(['poteto-mode', 'vision']);
    const vision = skills.find((s) => s.slug === 'vision')!;
    expect(vision.description).toContain('Draft and stress-test');
    expect(Object.keys(vision.files)).toEqual(['assets/review-template.html', 'assets/review.css']);
    expect(vision.tags).toEqual(['imported']);
    const poteto = skills.find((s) => s.slug === 'poteto-mode')!;
    expect(poteto.files).toEqual({});
  });

  it('fails closed on auth errors, missing repos, rate limits, non-GitHub redirects, and empty repos', async () => {
    const mockStatus = (status: number, headers?: Record<string, string>) =>
      (async () => new Response('err', { status, headers })) as unknown as typeof fetch;

    await expect(
      fetchGitHubSkills({ kind: 'skill_repo', url: 'owner/private' }, { fetchImpl: mockStatus(404) }),
    ).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });

    await expect(
      fetchGitHubSkills({ kind: 'skill_repo', url: 'owner/private' }, { bearerToken: 'ghp_123', fetchImpl: mockStatus(401) }),
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });

    await expect(
      fetchGitHubSkills({ kind: 'skill_repo', url: 'owner/repo' }, { fetchImpl: mockStatus(429) }),
    ).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });

    const seenHeaders: Array<HeadersInit | undefined> = [];
    await expect(
      fetchGitHubSkills(
        { kind: 'skill_repo', url: 'owner/private' },
        {
          bearerToken: 'ghp_secret',
          fetchImpl: (async (_url, init) => {
            seenHeaders.push(init?.headers);
            return new Response(null, { status: 302, headers: { location: 'https://evil.example/evil.tar.gz' } });
          }) as unknown as typeof fetch,
        },
      ),
    ).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
    expect(seenHeaders).toHaveLength(1);

    const noSkills = buildTarGz([{ path: 'repo-HEAD/README.md', content: '# Nothing here' }]);
    await expect(
      fetchGitHubSkills(
        { kind: 'skill_repo', url: 'owner/empty' },
        { fetchImpl: (async () => new Response(Buffer.from(noSkills), { status: 200 })) as unknown as typeof fetch },
      ),
    ).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
  });

  it('falls back to sparse Git Trees + raw fetches when repository archive exceeds size limit and fails closed on sparse errors', async () => {
    const axiMd = '---\nname: axi\ndescription: Agent eXperience Interface CLI principles.\n---\n# AXI\nUse TOON.';
    const siblingDoc = '# Spec\nTOON saves tokens.';
    const treePayload = {
      sha: 'deadbeef1234',
      tree: [
        { path: '../escape/SKILL.md', type: 'blob', size: 100 },
        { path: 'bench-browser/massive.txt', type: 'blob', size: 40_000_000 },
        { path: '.agents/skills/axi/SKILL.md', type: 'blob', size: axiMd.length },
        { path: '.agents/skills/axi/notes.md', type: 'blob', size: siblingDoc.length },
        { path: '.agents/skills/axi/linked.md', type: 'blob', mode: '120000', size: 11 },
        { path: '.agents/skills/axi/corrupt.txt', type: 'blob', size: 4 },
      ],
    };

    const seenUrls: string[] = [];
    const fetchSparse = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      seenUrls.push(url);
      if (url.startsWith('https://codeload.github.com/')) {
        return new Response('too big', {
          status: 200,
          headers: { 'content-length': String(MAX_DOWNLOAD_BYTES + 1024) },
        });
      }
      if (url === 'https://api.github.com/repos/kunchenguid/axi/git/trees/HEAD?recursive=1') {
        return new Response(JSON.stringify(treePayload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === 'https://raw.githubusercontent.com/kunchenguid/axi/HEAD/.agents/skills/axi/SKILL.md') {
        return new Response(axiMd, { status: 200 });
      }
      if (url === 'https://raw.githubusercontent.com/kunchenguid/axi/HEAD/.agents/skills/axi/notes.md') {
        return new Response(siblingDoc, { status: 200 });
      }
      if (url === 'https://raw.githubusercontent.com/kunchenguid/axi/HEAD/.agents/skills/axi/corrupt.txt') {
        return new Response(new Uint8Array([0xc3, 0x28, 0xa0, 0xa1]), { status: 200 });
      }
      return new Response('unexpected', { status: 404 });
    });

    const skills = await fetchGitHubSkills(
      { kind: 'skill_repo', url: 'https://github.com/kunchenguid/axi' },
      { fetchImpl: fetchSparse as unknown as typeof fetch },
    );
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      slug: 'axi',
      content: axiMd,
    });
    expect(skills[0].files).toEqual({ 'notes.md': siblingDoc });
    expect(seenUrls).toContain('https://raw.githubusercontent.com/kunchenguid/axi/HEAD/.agents/skills/axi/corrupt.txt');
    expect(seenUrls).not.toContain('https://raw.githubusercontent.com/kunchenguid/axi/HEAD/bench-browser/massive.txt');
    expect(seenUrls).not.toContain('https://raw.githubusercontent.com/kunchenguid/axi/HEAD/.agents/skills/axi/linked.md');
    expect(seenUrls.some(url => url.includes('deadbeef1234'))).toBe(false);

    await expect(
      fetchGitHubSkills(
        { kind: 'skill_repo', url: 'owner/big' },
        {
          fetchImpl: (async (input: RequestInfo | URL) => {
            if (String(input).startsWith('https://codeload.github.com/')) {
              return new Response('big', { status: 200, headers: { 'content-length': String(MAX_DOWNLOAD_BYTES + 1) } });
            }
            return new Response('rate limited', { status: 429 });
          }) as unknown as typeof fetch,
        },
      ),
    ).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });

    await expect(
      fetchGitHubSkills(
        { kind: 'skill_repo', url: 'owner/big-empty' },
        {
          fetchImpl: (async (input: RequestInfo | URL) => {
            if (String(input).startsWith('https://codeload.github.com/')) {
              return new Response('big', { status: 200, headers: { 'content-length': String(MAX_DOWNLOAD_BYTES + 1) } });
            }
            return new Response(JSON.stringify({
              sha: 'abc',
              tree: [{ path: '../outside/SKILL.md', type: 'blob', size: 10 }],
            }), { status: 200, headers: { 'content-type': 'application/json' } });
          }) as unknown as typeof fetch,
        },
      ),
    ).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
  });

  it('fetches sparse files at the configured ref rather than the tree object SHA, including through the contents API', async () => {
    const skillMd = '---\nname: tagged\ndescription: Pinned skill.\n---\n# Tagged';
    const seenUrls: string[] = [];
    const fetchSparse = (async (input: RequestInfo | URL) => {
      const url = String(input);
      seenUrls.push(url);
      if (url.includes('/tarball/') || url.startsWith('https://codeload.github.com/')) {
        return new Response('too big', { status: 200, headers: { 'content-length': String(MAX_DOWNLOAD_BYTES + 1) } });
      }
      if (url === 'https://api.github.com/repos/owner/pinned/git/trees/release/v2?recursive=1') {
        return Response.json({ sha: 'tree-object-sha', tree: [{ path: 'skills/tagged/SKILL.md', type: 'blob', mode: '100644', size: skillMd.length }] });
      }
      if (url === 'https://raw.githubusercontent.com/owner/pinned/release/v2/skills/tagged/SKILL.md'
        || url === 'https://api.github.com/repos/owner/pinned/contents/skills/tagged/SKILL.md?ref=release%2Fv2') {
        return new Response(skillMd, { status: 200 });
      }
      return new Response('unexpected', { status: 404 });
    }) as unknown as typeof fetch;

    for (const bearerToken of [undefined, 'ghp_pinned']) {
      const skills = await fetchGitHubSkills(
        { kind: 'skill_repo', url: 'https://github.com/owner/pinned', ref: 'release/v2' },
        { fetchImpl: fetchSparse, ...(bearerToken ? { bearerToken } : {}) },
      );
      expect(skills.map(skill => skill.slug)).toEqual(['tagged']);
    }
    expect(seenUrls.some(url => url.includes('tree-object-sha'))).toBe(false);
  });

  it('fails closed when GitHub truncates the sparse tree listing', async () => {
    const fetched: string[] = [];
    await expect(fetchGitHubSkills(
      { kind: 'skill_repo', url: 'owner/huge' },
      {
        fetchImpl: (async (input: RequestInfo | URL) => {
          const url = String(input);
          fetched.push(url);
          if (url.startsWith('https://codeload.github.com/')) {
            return new Response('big', { status: 200, headers: { 'content-length': String(MAX_DOWNLOAD_BYTES + 1) } });
          }
          if (url.includes('/git/trees/')) {
            return Response.json({ sha: 'abc', truncated: true, tree: [{ path: 'skills/a/SKILL.md', type: 'blob', size: 10 }] });
          }
          return new Response('---\nname: a\n---\n# A', { status: 200 });
        }) as unknown as typeof fetch,
      },
    )).rejects.toMatchObject({ code: 'UPSTREAM_ERROR', message: expect.stringContaining('truncated') });
    expect(fetched.some(url => url.startsWith('https://raw.githubusercontent.com/'))).toBe(false);
  });

  it('serves imported repo skills, sibling files, prompts, proposals, and secret-free exports through real runtime + MCP', async () => {
    const tarball = buildTarGz([
      { path: 'vision-HEAD/skills/vision/SKILL.md', content: visionMd },
      { path: 'vision-HEAD/skills/vision/assets/review.css', content: 'body { color: #000; }' },
    ]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).startsWith('https://codeload.github.com/kunchenguid/vision/')) {
          return new Response(Buffer.from(tarball), { status: 200 });
        }
        return new Response('not found', { status: 404 });
      }),
    );

    const homeDir = await mkdtemp(join(tmpdir(), 'af-gh-skills-'));
    temps.push(homeDir);
    const runtime = await createGatewayRuntime({
      mode: 'local',
      homeDir,
      publicUrl: 'http://127.0.0.1:7432',
      traceStore: new MemoryTraceStore(),
    });

    try {
      const { token } = await runtime.createToken({ label: 'agent', profileId: 'default' });
      const sdk = new Client({ name: 'test-client', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
      const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:7432/mcp'), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
        fetch: (url, init) => runtime.handleMcpRequest(new Request(url, init), null),
      });
      await sdk.connect(transport);

      try {
        const proposed = await sdk.callTool({
          name: 'fabric_propose_capability',
          arguments: {
            kind: 'skill_repo',
            name: 'vision',
            description: 'Add kunchenguid/vision skill',
            definition: { kind: 'skill_repo', url: 'https://github.com/kunchenguid/vision' },
          },
        });
        const { id: proposalId, status, reviewUrl } = proposed.structuredContent as {
          id: string;
          status: string;
          reviewUrl: string;
        };
        expect(status).toBe('pending_review');
        expect(reviewUrl).toBe('http://127.0.0.1:7432/#/safety');
        expect((await sdk.request({ method: 'skills/list' }, ListSkillsResultSchema)).skills).toEqual([]);

        const activated = await runtime.activateProposal(proposalId, 'Approved by operator');
        expect(activated.source.health).toBe('healthy');

        const listed = await sdk.request({ method: 'skills/list' }, ListSkillsResultSchema);
        expect(listed.skills).toHaveLength(1);
        const expectedDigest = `sha256:${createHash('sha256').update(visionMd).digest('hex')}`;
        expect(listed.skills[0]).toMatchObject({
          uri: 'skill://vision',
          frontmatter: { name: 'vision' },
          resources: [
            { uri: 'skill://vision', digest: expectedDigest },
            { uri: 'skill://vision/assets/review.css' },
          ],
        });

        expect(await sdk.request({ method: 'skills/get', params: { uri: 'skill://vision' } }, GetSkillResultSchema))
          .toMatchObject({ skill: { uri: 'skill://vision' } });
        expect(
          await sdk.request(
            { method: 'resources/directory/read', params: { uri: 'skill://vision' } },
            ReadResourceDirectoryResultSchema,
          ),
        ).toMatchObject({
          resources: [
            { uri: 'skill://vision', name: 'SKILL.md' },
            { uri: 'skill://vision/assets/review.css', name: 'assets/review.css', mimeType: 'text/css' },
          ],
        });

        expect(await sdk.readResource({ uri: 'skill://vision' })).toMatchObject({ contents: [{ text: visionMd }] });
        expect(await sdk.readResource({ uri: 'skill://vision/assets/review.css' }))
          .toMatchObject({ contents: [{ mimeType: 'text/css', text: 'body { color: #000; }' }] });
        expect(await sdk.getPrompt({ name: 'skill:vision' }))
          .toMatchObject({ messages: [{ content: { text: visionMd } }] });

        const caps = await runtime.listCapabilities({ kind: 'skill' });
        expect(caps).toHaveLength(1);
        const content = await runtime.getCapabilityContent(caps[0]!.id);
        expect(content.content).toBe(visionMd);
        expect(content.files).toEqual({ 'assets/review.css': 'body { color: #000; }' });

        const bundle = await runtime.exportConfig();
        expect(JSON.stringify(bundle)).not.toContain('Evidence over vibes.');
        expect(bundle.sources[0]?.config).toEqual({
          kind: 'skill_repo',
          url: 'https://github.com/kunchenguid/vision',
        });
      } finally {
        await sdk.close();
      }
    } finally {
      await runtime.close();
    }
  });
});
