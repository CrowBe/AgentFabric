export const echoSchema = {
  type: 'object', properties: { value: { type: 'string' } }, required: ['value'],
};

export const eventName = 'fixture.record.changed';

export function fixtureEvent(cursor) {
  return {
    name: eventName, eventId: 'fixture-event-1', timestamp: '2026-07-28T01:00:00Z',
    data: { value: 'upstream change' }, cursor,
  };
}

export function mcpResponse(request, prefix, secret) {
  const { id, method, params = {} } = request;
  const serverInfo = { name: `${prefix}-fixture`, version: '1.0.0' };
  const capabilities = {
    tools: {}, prompts: {}, resources: {},
    ...(prefix === 'http' ? { extensions: { 'io.modelcontextprotocol/events': {} } } : {}),
  };
  const results = {
    'server/discover': () => ({ supportedVersions: ['2026-07-28'], capabilities }),
    'tools/list': () => ({ tools: [
      { name: `${prefix}_echo`, description: `Echo a value over ${prefix}`, inputSchema: echoSchema },
      ...(prefix === 'stdio' ? [{
        name: 'stdio_failure', description: 'Return a fixture error', inputSchema: { type: 'object' },
      }] : []),
    ] }),
    'tools/call': () => params.name === 'stdio_failure'
      ? { isError: true, content: [{ type: 'text', text: `Credential rejected: ${secret}` }] }
      : { content: [{ type: 'text', text: `${prefix}:${params.arguments.value}` }] },
    'prompts/list': () => ({ prompts: [{ name: `${prefix}_greet`, arguments: [{ name: 'name', required: true }] }] }),
    'prompts/get': () => ({ messages: [{ role: 'user', content: { type: 'text', text: `${prefix} says hello to ${params.arguments.name}` } }] }),
    'resources/list': () => ({ resources: [{ name: `${prefix}_guide`, uri: `${prefix}://guide` }] }),
    'resources/templates/list': () => ({ resourceTemplates: [] }),
    'resources/read': () => ({ contents: [{ uri: params.uri, text: `${prefix} fixture guide` }] }),
    'events/list': () => ({ events: [{
      name: eventName, description: 'A fixture record changed', delivery: ['poll', 'push'],
      inputSchema: { type: 'object', additionalProperties: false }, payloadSchema: echoSchema,
    }] }),
    'events/poll': () => ({ events: [fixtureEvent('fixture-next')], cursor: 'fixture-next', nextPollMs: 1000 }),
  };
  if (!Object.hasOwn(results, method)) {
    return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
  }
  return {
    jsonrpc: '2.0', id,
    result: { ...results[method](), ttlMs: 0, cacheScope: 'private', resultType: 'complete', _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo } },
  };
}
