import { useEffect, useState } from 'react';
import { Tabs, TabsList, TabsPanel, TabsTab } from '@ui-sdk/react/tabs';
import type { GatewayMode, SourceKind } from '../../../src/types/index.js';
import { api, describeError, type RecipeInfo, type SourceRecord } from '../api';
import {
  CUSTOM_FIELDS,
  DynamicForm,
  KIND_LABELS,
  OAUTH_FIELD_NAMES,
  buildCustomSource,
  initialValues,
  type FormValues,
} from './source-forms';
import { Button, CopyButton, Modal, Notice, Pill, SelectField, notify, useResource } from './ui';

export interface AddSourceInitial {
  tab: 'recipe' | 'custom';
  recipeId?: string;
  kind?: SourceKind;
}

export function AddSourceDialog({
  open,
  onClose,
  onCreated,
  mode,
  publicUrl,
  initial = { tab: 'recipe' },
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (source: SourceRecord) => void;
  mode: GatewayMode;
  publicUrl?: string;
  initial?: AddSourceInitial;
}) {
  const recipes = useResource(() => api.recipes(), []);
  const [tab, setTab] = useState<'recipe' | 'custom'>(initial.tab);
  const [recipeId, setRecipeId] = useState(initial.recipeId ?? '');
  const [kind, setKind] = useState<SourceKind>(initial.kind ?? 'mcp_http');
  const [recipeValues, setRecipeValues] = useState<FormValues>({});
  const [customValues, setCustomValues] = useState<FormValues>(() => initialValues(CUSTOM_FIELDS[initial.kind ?? 'mcp_http']));
  const [refreshMode, setRefreshMode] = useState<'manual' | 'on_connect' | 'interval'>('manual');
  const [refreshSeconds, setRefreshSeconds] = useState('900');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const recipe: RecipeInfo | undefined =
    recipes.data?.find((r) => r.id === recipeId) ?? (initial.recipeId ? undefined : recipes.data?.[0]);

  useEffect(() => {
    if (!open) return;
    setTab(initial.tab);
    setRecipeId(initial.recipeId ?? '');
    setKind(initial.kind ?? 'mcp_http');
    setCustomValues(initialValues(CUSTOM_FIELDS[initial.kind ?? 'mcp_http']));
    setError(undefined);
  }, [open, initial.tab, initial.recipeId, initial.kind]);

  useEffect(() => {
    if (recipe) setRecipeValues(initialValues(recipe.fields));
  }, [recipe?.id]);

  const blockedByMode = tab === 'recipe' && recipe?.localOnly && mode === 'remote';
  const customOAuth = kind === 'mcp_http' && Boolean(customValues.useOAuth);
  const customFields =
    kind === 'mcp_http' && !customOAuth
      ? CUSTOM_FIELDS[kind].filter((field) => !OAUTH_FIELD_NAMES.has(field.name))
      : CUSTOM_FIELDS[kind];
  const callbackUrl = publicUrl ? `${publicUrl.replace(/\/+$/, '')}/auth/oauth/callback` : '/auth/oauth/callback';
  const callbackNotice = (
    <Notice tone="info" title="OAuth callback URL">
      <div className="row wrap">
        <code>{callbackUrl}</code>
        <CopyButton text={callbackUrl} label="OAuth callback URL" />
      </div>
      <p>Pre-registered OAuth clients must register this exact Redirect URI with their provider.</p>
    </Notice>
  );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(undefined);
    setBusy(true);
    try {
      let source: SourceRecord;
      if (tab === 'recipe') {
        if (!recipe) throw new Error('Choose a recipe');
        source = await api.instantiateRecipe(recipe.id, recipeValues);
      } else {
        source = await api.createSource(
          buildCustomSource(kind, customValues, { mode: refreshMode, seconds: refreshSeconds }),
        );
      }
      notify.success('Source added', source.name);
      onCreated(source);
      onClose();
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title="Add a source"
      description="Sources pass straight through to the pool. Normalise them later, if you want."
    >
      <form onSubmit={submit} className="stack">
        <Tabs value={tab} onValueChange={(next: string | null) => next && setTab(next as 'recipe' | 'custom')}>
          <TabsList aria-label="How to add" className="subtabs">
            <TabsTab value="recipe">Starter recipes</TabsTab>
            <TabsTab value="custom">Custom source</TabsTab>
          </TabsList>
          <TabsPanel value="recipe">
            <div className="stack">
              {recipes.error ? <Notice tone="error">{recipes.error}</Notice> : null}
              <SelectField
                label="Recipe"
                value={recipe?.id ?? ''}
                onChange={setRecipeId}
                options={(recipes.data ?? []).map((r) => ({ value: r.id, label: r.title }))}
              />
              {recipe ? (
                <>
                  <p className="muted">
                    {recipe.description} {recipe.localOnly ? <Pill tone="warn">local mode only</Pill> : null}
                  </p>
                  {blockedByMode ? (
                    <Notice tone="warn">
                      This recipe runs on the machine hosting the gateway. Remote gateways never reach into local CLIs or folders.
                    </Notice>
                  ) : null}
                  <DynamicForm
                    fields={recipe.fields}
                    values={recipeValues}
                    onChange={(key, value) => setRecipeValues((c) => ({ ...c, [key]: value }))}
                  />
                  {recipe.id === 'mcp-http-oauth' ? callbackNotice : null}
                </>
              ) : null}
            </div>
          </TabsPanel>
          <TabsPanel value="custom">
            <div className="stack">
              <SelectField
                label="Source kind"
                value={kind}
                onChange={(next) => {
                  setKind(next as SourceKind);
                  setCustomValues(initialValues(CUSTOM_FIELDS[next as SourceKind]));
                }}
                options={(Object.keys(KIND_LABELS) as SourceKind[]).map((k) => ({ value: k, label: KIND_LABELS[k] }))}
              />
              <DynamicForm
                fields={customFields}
                values={customValues}
                onChange={(key, value) => setCustomValues((c) => ({ ...c, [key]: value }))}
              />
              {customOAuth ? callbackNotice : null}
              <SelectField
                label="Refresh policy"
                value={refreshMode}
                onChange={(next) => setRefreshMode(next as typeof refreshMode)}
                options={[
                  { value: 'manual', label: 'Manual' },
                  { value: 'on_connect', label: 'On connect' },
                  { value: 'interval', label: 'On an interval' },
                ]}
              />
              {refreshMode === 'interval' ? (
                <label className="inline-field">
                  Interval (seconds)
                  <input type="number" min={5} value={refreshSeconds} onChange={(e) => setRefreshSeconds(e.target.value)} />
                </label>
              ) : null}
            </div>
          </TabsPanel>
        </Tabs>
        {error ? <Notice tone="error" title="Could not add source">{error}</Notice> : null}
        <div className="row end">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" data-variant="solid" disabled={busy || Boolean(blockedByMode)}>
            {busy ? 'Adding…' : 'Add source'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
