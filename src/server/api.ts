import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import type { z } from 'zod';
import { getRecipe, instantiateRecipe, listRecipes } from '../deploy/recipes.js';
import { GatewayError, type GatewayRuntime } from '../types/index.js';
import {
  capabilityQuerySchema,
  createPolicySchema,
  createProfileSchema,
  createSourceSchema,
  createTokenSchema,
  decideApprovalSchema,
  draftPolicySchema,
  emitEventSchema,
  importConfigSchema,
  occurrenceQuerySchema,
  overlayDraftSchema,
  overlayInputSchema,
  parseInput,
  profileQuerySchema,
  proposalQuerySchema,
  recipeInstantiateSchema,
  reviewNoteSchema,
  secretNameSchema,
  setSecretSchema,
  statusQuerySchema,
  telemetryEventsQuerySchema,
  telemetrySummaryQuerySchema,
  updateProfileSchema,
  updateSourceSchema,
} from './schemas.js';
import { buildConnectSnippets } from './snippets.js';

const HEARTBEAT_MS = 15_000;

async function readJson<S extends z.ZodType>(
  c: Context,
  schema: S,
  options: { optional?: boolean } = {},
): Promise<z.output<S>> {
  const text = await c.req.text();
  if (!text.trim()) {
    if (options.optional) return parseInput(schema, {});
    throw new GatewayError('INVALID_INPUT', 'Request body is required');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new GatewayError('INVALID_INPUT', 'Request body must be valid JSON');
  }
  return parseInput(schema, raw);
}

const parseQuery = <S extends z.ZodType>(c: Context, schema: S): z.output<S> =>
  parseInput(schema, c.req.query(), 'query');

function requireFound<T>(value: T | null | undefined, what: string, id: string): T {
  if (value === null || value === undefined) {
    throw new GatewayError('NOT_FOUND', `${what} '${id}' not found`);
  }
  return value;
}

export function createOperatorGuard(runtime: GatewayRuntime): MiddlewareHandler {
  return async (c, next) => {
    let allowed = false;
    try {
      allowed = runtime.authenticateOperator(c.req.raw);
    } catch {
      allowed = false;
    }
    if (!allowed) {
      c.header('www-authenticate', 'Bearer realm="agentfabric-operator"');
      throw new GatewayError('UNAUTHORIZED', 'Operator authentication required', 401);
    }
    c.header('cache-control', 'no-store');
    await next();
  };
}

export function createApi(runtime: GatewayRuntime): Hono {
  const api = new Hono();
  api.use(
    '*',
    bodyLimit({
      maxSize: 4 * 1024 * 1024,
      onError: (c) =>
        c.json(
          { error: { code: 'INVALID_INPUT', message: 'Request body too large' } },
          413,
        ),
    }),
  );

  api.get('/status', async (c) => c.json(await runtime.getStatus()));

  api.get('/sources', async (c) => c.json({ sources: await runtime.listSources() }));
  api.post('/sources', async (c) => {
    const input = await readJson(c, createSourceSchema);
    return c.json({ source: await runtime.createSource(input) }, 201);
  });
  api.get('/sources/:id', async (c) => {
    const id = c.req.param('id');
    return c.json({ source: requireFound(await runtime.getSource(id), 'Source', id) });
  });
  api.patch('/sources/:id', async (c) => {
    const patch = await readJson(c, updateSourceSchema);
    return c.json({ source: await runtime.updateSource(c.req.param('id'), patch) });
  });
  api.delete('/sources/:id', async (c) => {
    await runtime.deleteSource(c.req.param('id'));
    return c.json({ ok: true });
  });
  api.post('/sources/:id/refresh', async (c) =>
    c.json(await runtime.refreshSource(c.req.param('id'))),
  );
  api.post('/sources/:id/test', async (c) =>
    c.json(await runtime.testSource(c.req.param('id'))),
  );

  api.get('/sources/:id/oauth', async (c) =>
    c.json({ oauth: await runtime.getUpstreamOAuthStatus(c.req.param('id')) }));
  api.post('/sources/:id/oauth/start', async (c) =>
    c.json(await runtime.startUpstreamOAuth(c.req.param('id'))));
  api.delete('/sources/:id/oauth', async (c) => {
    await runtime.disconnectUpstreamOAuth(c.req.param('id'));
    return c.json({ ok: true });
  });

  api.get('/recipes', (c) => c.json({ recipes: listRecipes() }));
  api.post('/recipes/:id/instantiate', async (c) => {
    const id = c.req.param('id');
    requireFound(getRecipe(id), 'Recipe', id);
    const { values } = await readJson(c, recipeInstantiateSchema);
    const { recipe, input } = instantiateRecipe(id, values);
    if (recipe.localOnly && runtime.mode === 'remote') {
      throw new GatewayError(
        'REMOTE_CLI_FORBIDDEN',
        `Recipe '${recipe.id}' runs on the local machine and is disabled in remote mode`,
      );
    }
    const checked = parseInput(createSourceSchema, input, 'recipe result');
    return c.json({ source: await runtime.createSource(checked) }, 201);
  });

  api.get('/capabilities', async (c) =>
    c.json({
      capabilities: await runtime.listCapabilities(parseQuery(c, capabilityQuerySchema)),
    }),
  );
  api.get('/capabilities/:id/content', async (c) =>
    c.json(await runtime.getCapabilityContent(c.req.param('id'))),
  );
  api.post('/capabilities/:id/overlay/draft', async (c) => {
    const { guidance } = await readJson(c, overlayDraftSchema, { optional: true });
    return c.json({ overlay: await runtime.draftOverlay(c.req.param('id'), guidance) });
  });
  api.put('/capabilities/:id/overlay', async (c) => {
    const overlay = await readJson(c, overlayInputSchema);
    return c.json({ overlay: await runtime.applyOverlay(c.req.param('id'), overlay) });
  });
  api.delete('/capabilities/:id/overlay', async (c) => {
    await runtime.deleteOverlay(c.req.param('id'));
    return c.json({ ok: true });
  });

  api.get('/profiles', async (c) => c.json({ profiles: await runtime.listProfiles() }));
  api.post('/profiles', async (c) => {
    const input = await readJson(c, createProfileSchema);
    return c.json({ profile: await runtime.createProfile(input) }, 201);
  });
  api.get('/profiles/:id', async (c) => {
    const id = c.req.param('id');
    return c.json({ profile: requireFound(await runtime.getProfile(id), 'Profile', id) });
  });
  api.patch('/profiles/:id', async (c) => {
    const patch = await readJson(c, updateProfileSchema);
    return c.json({ profile: await runtime.updateProfile(c.req.param('id'), patch) });
  });
  api.delete('/profiles/:id', async (c) => {
    await runtime.deleteProfile(c.req.param('id'));
    return c.json({ ok: true });
  });
  api.get('/profiles/:id/connect-snippets', async (c) => {
    const id = c.req.param('id');
    const profile = requireFound(await runtime.getProfile(id), 'Profile', id);
    return c.json(
      buildConnectSnippets({ profile, publicUrl: runtime.publicUrl, mode: runtime.mode }),
    );
  });

  api.get('/tokens', async (c) => c.json({ tokens: await runtime.listTokens() }));
  api.post('/tokens', async (c) => {
    const input = await readJson(c, createTokenSchema);
    return c.json(await runtime.createToken(input), 201);
  });
  api.delete('/tokens/:id', async (c) => {
    await runtime.revokeToken(c.req.param('id'));
    return c.json({ ok: true });
  });
  api.get('/oauth-clients', async (c) =>
    c.json({ clients: await runtime.listOAuthClients() }),
  );
  api.delete('/oauth-clients/:id', async (c) => {
    await runtime.revokeOAuthClient(c.req.param('id'));
    return c.json({ ok: true });
  });

  api.get('/secrets', async (c) => c.json({ secrets: await runtime.listSecrets() }));
  api.put('/secrets/:name', async (c) => {
    const name = parseInput(secretNameSchema, c.req.param('name'), 'secret name');
    const { value, description } = await readJson(c, setSecretSchema);
    return c.json({ secret: await runtime.setSecret(name, value, description) });
  });
  api.delete('/secrets/:name', async (c) => {
    const name = parseInput(secretNameSchema, c.req.param('name'), 'secret name');
    await runtime.deleteSecret(name);
    return c.json({ ok: true });
  });

  api.get('/policies', async (c) => c.json({ policies: await runtime.listPolicies() }));
  api.post('/policies/draft', async (c) => {
    const input = await readJson(c, draftPolicySchema);
    return c.json({ policy: await runtime.draftPolicy(input) });
  });
  api.post('/policies', async (c) => {
    const input = await readJson(c, createPolicySchema);
    return c.json({ policy: await runtime.createPolicy(input) }, 201);
  });
  api.delete('/policies/:id', async (c) => {
    await runtime.deletePolicy(c.req.param('id'));
    return c.json({ ok: true });
  });

  api.get('/approvals', async (c) => {
    const { status } = parseQuery(c, statusQuerySchema);
    return c.json({ approvals: await runtime.listApprovals(status) });
  });
  api.get('/approvals/stream', (c) =>
    streamSSE(c, async (stream) => {
      const unsubscribe = runtime.subscribeApprovals((event) => {
        stream
          .writeSSE({ event: 'approval', data: JSON.stringify(event) })
          .catch(() => undefined);
      });
      const heartbeat = setInterval(() => {
        stream.writeSSE({ event: 'ping', data: '{}' }).catch(() => undefined);
      }, HEARTBEAT_MS);
      const aborted = new Promise<void>((resolve) => stream.onAbort(resolve));
      try {
        const pending = await runtime.listApprovals('pending');
        await stream.writeSSE({
          event: 'snapshot',
          data: JSON.stringify({ approvals: pending }),
        });
        await aborted;
      } finally {
        clearInterval(heartbeat);
        unsubscribe();
      }
    }),
  );
  api.post('/approvals/:id/decide', async (c) => {
    const { decision, note } = await readJson(c, decideApprovalSchema);
    return c.json({
      approval: await runtime.decideApproval(c.req.param('id'), decision, note),
    });
  });

  api.get('/proposals', async (c) => {
    const { status } = parseQuery(c, proposalQuerySchema);
    return c.json({ proposals: await runtime.listProposals(status) });
  });
  api.post('/proposals/:id/activate', async (c) => {
    const { note } = await readJson(c, reviewNoteSchema, { optional: true });
    return c.json(await runtime.activateProposal(c.req.param('id'), note));
  });
  api.post('/proposals/:id/reject', async (c) => {
    const { note } = await readJson(c, reviewNoteSchema, { optional: true });
    return c.json({ proposal: await runtime.rejectProposal(c.req.param('id'), note) });
  });

  api.get('/events/types', async (c) => {
    const { profileId } = parseQuery(c, profileQuerySchema);
    return c.json({ eventTypes: await runtime.listEventTypes(profileId) });
  });
  api.get('/events/subscriptions', async (c) => {
    const { profileId } = parseQuery(c, profileQuerySchema);
    return c.json({ subscriptions: await runtime.listEventSubscriptions(profileId) });
  });
  api.delete('/events/subscriptions/:id', async (c) => {
    await runtime.deleteEventSubscription(c.req.param('id'));
    return c.json({ ok: true });
  });
  api.get('/events/occurrences', async (c) =>
    c.json({
      occurrences: await runtime.listEventOccurrences(parseQuery(c, occurrenceQuerySchema)),
    }),
  );
  api.post('/events/emit', async (c) => {
    const input = await readJson(c, emitEventSchema);
    return c.json({ occurrence: await runtime.emitEvent(input) }, 201);
  });

  api.get('/telemetry/summary', async (c) =>
    c.json(await runtime.getTelemetrySummary(parseQuery(c, telemetrySummaryQuerySchema))),
  );
  api.get('/telemetry/events', async (c) =>
    c.json({
      events: await runtime.listTelemetryEvents(parseQuery(c, telemetryEventsQuerySchema)),
    }),
  );
  api.get('/telemetry/hints', async (c) => {
    const { profileId } = parseQuery(c, profileQuerySchema);
    return c.json({ hints: await runtime.getCurationHints(profileId) });
  });

  api.get('/config/export', async (c) => c.json(await runtime.exportConfig()));
  api.post('/config/import', async (c) => {
    const { bundle, merge, enableExecutables } = await readJson(c, importConfigSchema);
    return c.json(
      await runtime.importConfig(bundle, {
        merge: merge ?? true,
        ...(enableExecutables !== undefined ? { enableExecutables } : {}),
      }),
    );
  });

  api.notFound((c) =>
    c.json({ error: { code: 'NOT_FOUND', message: 'No such API route' } }, 404),
  );
  return api;
}
