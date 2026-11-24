import type { GatewayMode, ProfileRecord } from '../types/index.js';

export const TOKEN_PLACEHOLDER = 'YOUR_AGENTFABRIC_TOKEN';
export const TOKEN_ENV_VAR = 'AGENTFABRIC_TOKEN';

export interface ConnectSnippet {
  id: 'claude-web' | 'claude-code' | 'codex' | 'cursor' | 'generic-mcp';
  label: string;
  description: string;
  auth: 'oauth' | 'bearer';
  language: 'text' | 'bash' | 'json' | 'toml';
  /** Where the operator pastes this. The gateway never writes it for them. */
  target: string;
  content: string;
}

export interface ConnectSnippets {
  profile: { id: string; name: string };
  mcpUrl: string;
  endpoints: {
    mcp: string;
    profileMcp: string;
    protectedResourceMetadata: string;
    authorizationServerMetadata: string;
  };
  tokenPlaceholder: string;
  tokenEnvVar: string;
  surfaces: string[];
  localWrites: 'none';
  warnings: string[];
  snippets: ConnectSnippet[];
}

function isLoopback(url: URL): boolean {
  return (
    url.hostname === 'localhost' ||
    url.hostname === '127.0.0.1' ||
    url.hostname === '[::1]' ||
    url.hostname.endsWith('.localhost')
  );
}

export function buildConnectSnippets(input: {
  profile: ProfileRecord;
  publicUrl: string;
  mode: GatewayMode;
}): ConnectSnippets {
  const base = input.publicUrl.replace(/\/+$/, '');
  const profileMcp = `${base}/mcp/${encodeURIComponent(input.profile.name)}`;

  const warnings: string[] = [];
  try {
    const url = new URL(base);
    if (url.protocol !== 'https:' && !isLoopback(url)) {
      warnings.push(
        'This URL is not HTTPS. Remote harnesses require HTTPS; put the gateway behind Tailscale Funnel, Cloudflare Tunnel, or a Cloudflare Workers deployment.',
      );
    }
    if (isLoopback(url)) {
      warnings.push(
        'This URL is loopback-only. Local harnesses (Claude Code, Codex, Cursor) can use it directly; Claude on the web needs a public HTTPS URL from a tunnel or a remote deployment (set AGENTFABRIC_PUBLIC_URL).',
      );
    }
  } catch {
    warnings.push('The configured public URL is not a valid URL.');
  }

  const snippets: ConnectSnippet[] = [
    {
      id: 'claude-web',
      label: 'Claude on the web (OAuth)',
      description:
        'Add a custom connector. Claude registers itself over OAuth 2.1 with PKCE; you approve it once on the gateway consent page.',
      auth: 'oauth',
      language: 'text',
      target: 'Claude → Settings → Connectors → Add custom connector',
      content: [
        `Name: AgentFabric (${input.profile.name})`,
        `Remote MCP server URL: ${profileMcp}`,
        '',
        'Leave the client ID and secret empty. Claude discovers the gateway through',
        `${base}/.well-known/oauth-protected-resource`,
        'registers a client, then opens the gateway consent page where you enter your operator token to approve.',
      ].join('\n'),
    },
    {
      id: 'claude-code',
      label: 'Claude Code',
      description: 'One command registers the gateway over streamable HTTP.',
      auth: 'bearer',
      language: 'bash',
      target: 'Run in your terminal (Claude Code stores it in its own config)',
      content: [
        `export ${TOKEN_ENV_VAR}='${TOKEN_PLACEHOLDER}'`,
        `claude mcp add --transport http agentfabric ${profileMcp} \\`,
        `  --header "Authorization: Bearer $${TOKEN_ENV_VAR}"`,
      ].join('\n'),
    },
    {
      id: 'codex',
      label: 'Codex',
      description: 'Streamable HTTP server with the token read from an environment variable.',
      auth: 'bearer',
      language: 'toml',
      target: 'Paste into ~/.codex/config.toml yourself',
      content: [
        `# export ${TOKEN_ENV_VAR}='${TOKEN_PLACEHOLDER}'`,
        '[mcp_servers.agentfabric]',
        `url = "${profileMcp}"`,
        `bearer_token_env_var = "${TOKEN_ENV_VAR}"`,
      ].join('\n'),
    },
    {
      id: 'cursor',
      label: 'Cursor',
      description: 'Remote MCP entry with the token interpolated from the environment.',
      auth: 'bearer',
      language: 'json',
      target: 'Paste into Cursor’s mcp.json yourself',
      content: JSON.stringify(
        {
          mcpServers: {
            agentfabric: {
              url: profileMcp,
              headers: { Authorization: `Bearer \${env:${TOKEN_ENV_VAR}}` },
            },
          },
        },
        null,
        2,
      ),
    },
    {
      id: 'generic-mcp',
      label: 'Generic MCP 2026-07-28 + Events',
      description:
        'Reference connection shape for any MCP client: tools, prompts, resources, skills (io.modelcontextprotocol/skills), and events (io.modelcontextprotocol/events) over this one endpoint.',
      auth: 'bearer',
      language: 'json',
      target: 'Adapt to your client’s MCP server configuration',
      content: JSON.stringify(
        {
          name: 'agentfabric',
          transport: 'streamable-http',
          url: profileMcp,
          headers: { Authorization: `Bearer ${TOKEN_PLACEHOLDER}` },
          protocolVersion: '2026-07-28',
          extensions: {
            'io.modelcontextprotocol/events': {},
            'io.modelcontextprotocol/skills': {},
          },
          surfaces: ['tools', 'prompts', 'resources', 'skills', 'events'],
        },
        null,
        2,
      ),
    },
  ];

  return {
    profile: { id: input.profile.id, name: input.profile.name },
    mcpUrl: profileMcp,
    endpoints: {
      mcp: `${base}/mcp`,
      profileMcp,
      protectedResourceMetadata: `${base}/.well-known/oauth-protected-resource`,
      authorizationServerMetadata: `${base}/.well-known/oauth-authorization-server`,
    },
    tokenPlaceholder: TOKEN_PLACEHOLDER,
    tokenEnvVar: TOKEN_ENV_VAR,
    surfaces: [
      'tools',
      'prompts',
      'resources',
      'skills (skill:// via io.modelcontextprotocol/skills)',
      'events (io.modelcontextprotocol/events)',
    ],
    localWrites: 'none',
    warnings,
    snippets,
  };
}
