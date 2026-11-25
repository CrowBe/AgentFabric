import { useCallback, useEffect, useState, type ComponentType, type ReactElement } from 'react';
import { OverlayHost } from '@ui-sdk/react/overlays';
import { Tabs, TabsList, TabsPanel, TabsTab, TabsTabIcon } from '@ui-sdk/react/tabs';
import { Toast, ToastClose, ToastDescription, ToastTitle } from '@ui-sdk/react/toast';
import {
  ActivityIcon,
  BookOpenTextIcon,
  BoxesIcon,
  KeyRoundIcon,
  LayersIcon,
  LogOutIcon,
  PlugZapIcon,
  RadioIcon,
  ShieldCheckIcon,
  XIcon,
} from 'lucide-react';
import { api, clearToken, getToken, onUnauthorized } from './api';
import { ApprovalsProvider, useApprovals } from './components/approvals';
import { AuthSecrets } from './components/AuthSecrets';
import { Events } from './components/Events';
import { Overview } from './components/Overview';
import { Profiles } from './components/Profiles';
import { Safety } from './components/Safety';
import { Skills } from './components/Skills';
import { Sources } from './components/Sources';
import { Telemetry } from './components/Telemetry';
import { TokenGate } from './components/TokenGate';
import { Button, Pill, useResource } from './components/ui';

interface View {
  id: string;
  label: string;
  Icon: ComponentType;
}

const VIEWS: View[] = [
  { id: 'overview', label: 'Overview & Connect', Icon: PlugZapIcon },
  { id: 'sources', label: 'Sources & Pool', Icon: BoxesIcon },
  { id: 'skills', label: 'Skills & Folders', Icon: BookOpenTextIcon },
  { id: 'profiles', label: 'Profiles & Discovery', Icon: LayersIcon },
  { id: 'safety', label: 'Safety & Approvals', Icon: ShieldCheckIcon },
  { id: 'events', label: 'Events', Icon: RadioIcon },
  { id: 'auth', label: 'Auth & Secrets', Icon: KeyRoundIcon },
  { id: 'telemetry', label: 'Telemetry & Portability', Icon: ActivityIcon },
];

const routeFromHash = (): string => {
  const id = window.location.hash.replace(/^#\/?/, '').split('?')[0];
  return VIEWS.some((v) => v.id === id) ? id : 'overview';
};

function useRoute(): [string, (id: string) => void] {
  const [route, setRoute] = useState(routeFromHash);
  useEffect(() => {
    const onChange = () => setRoute(routeFromHash());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  const navigate = useCallback((id: string) => {
    window.location.hash = `#/${id}`;
  }, []);
  return [route, navigate];
}

function useNarrow(query = '(max-width: 54rem)'): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = () => setNarrow(list.matches);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);
  return narrow;
}

export function App() {
  const [authed, setAuthed] = useState(() => Boolean(getToken()));
  const [reason, setReason] = useState<string>();

  useEffect(
    () =>
      onUnauthorized(() => {
        clearToken();
        setReason('Your session was rejected. Sign in again.');
        setAuthed(false);
      }),
    [],
  );

  return (
    <ApprovalsProvider enabled={authed}>
      {authed ? <Console onSignOut={() => { clearToken(); setReason(undefined); setAuthed(false); }} /> : null}
      {!authed ? <TokenGate reason={reason} onAuthed={() => { setReason(undefined); setAuthed(true); }} /> : null}
      <OverlayHost
        toast={{
          children: () => (
            <Toast>
              <div data-slot="stack">
                <ToastTitle />
                <ToastDescription />
              </div>
              <ToastClose aria-label="Dismiss notification">
                <XIcon aria-hidden="true" />
              </ToastClose>
            </Toast>
          ),
        }}
      />
    </ApprovalsProvider>
  );
}

function Console({ onSignOut }: { onSignOut: () => void }) {
  const [route, navigate] = useRoute();
  const narrow = useNarrow();
  const status = useResource(() => api.status(), [], { intervalMs: 30_000 });
  const { pending } = useApprovals();

  useEffect(() => {
    const view = VIEWS.find((v) => v.id === route);
    document.title = `${view?.label ?? 'Console'} · AgentFabric`;
  }, [route]);

  const content: Record<string, ReactElement> = {
    overview: <Overview onNavigate={navigate} />,
    sources: <Sources />,
    skills: <Skills />,
    profiles: <Profiles />,
    safety: <Safety />,
    events: <Events />,
    auth: <AuthSecrets />,
    telemetry: <Telemetry />,
  };

  return (
    <div className="shell">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <strong className="brand">AgentFabric</strong>
        {status.data ? <Pill tone={status.data.mode === 'local' ? 'info' : 'ok'}>{status.data.mode} mode</Pill> : null}
        {pending.length > 0 ? (
          <Button data-size="sm" data-variant="solid" onClick={() => navigate('safety')}>
            {pending.length} pending approval{pending.length === 1 ? '' : 's'}
          </Button>
        ) : null}
        <span className="spacer" />
        <Button data-size="sm" onClick={onSignOut}>
          <LogOutIcon aria-hidden="true" /> Sign out
        </Button>
      </header>
      <Tabs
        value={route}
        onValueChange={(next: string | null) => next && navigate(next)}
        orientation={narrow ? 'horizontal' : 'vertical'}
        className="layout"
      >
        <nav aria-label="Gateway sections" className="nav">
          <TabsList aria-label="Gateway sections">
            {VIEWS.map(({ id, label, Icon }) => (
              <TabsTab key={id} value={id}>
                <TabsTabIcon>
                  <Icon />
                </TabsTabIcon>
                {label}
                {id === 'safety' && pending.length > 0 ? <span className="badge" aria-label={`${pending.length} pending`}>{pending.length}</span> : null}
              </TabsTab>
            ))}
          </TabsList>
        </nav>
        <main id="main" className="main">
          {VIEWS.map(({ id }) => (
            <TabsPanel key={id} value={id}>
              {content[id]}
            </TabsPanel>
          ))}
        </main>
      </Tabs>
    </div>
  );
}
