import { useState } from 'react';
import {
  Dialog,
  DialogBackdrop,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@ui-sdk/react/dialog';
import { LogInIcon } from 'lucide-react';
import { ApiError, api, clearToken, setToken } from '../api';
import { Button, Notice, TextField } from './ui';

/** Blocks the console until a valid operator token is provided. Never closable. */
export function TokenGate({ onAuthed, reason }: { onAuthed: () => void; reason?: string }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | undefined>(reason);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setToken(value.trim());
    try {
      await api.status();
      setValue('');
      onAuthed();
    } catch (caught) {
      clearToken();
      setError(
        caught instanceof ApiError && caught.status === 401
          ? 'That operator token was not accepted.'
          : 'Could not reach the gateway. Check that it is running.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open dismissible={false}>
      <DialogBackdrop />
      <DialogContent className="modal">
        <div data-slot="stack" className="modal-head">
          <DialogTitle>Operator sign-in</DialogTitle>
          <DialogDescription>
            Paste the operator token printed when the gateway started (or stored in <code>operator-token</code> in its home
            directory). It stays in this tab only and is forgotten when you close it.
          </DialogDescription>
        </div>
        <form className="stack modal-body" onSubmit={submit}>
          <TextField label="Operator token" value={value} onChange={setValue} type="password" required autoComplete="current-password" mono />
          {error ? <Notice tone="error">{error}</Notice> : null}
          <div className="row end">
            <Button type="submit" data-variant="solid" disabled={busy || !value.trim()}>
              <LogInIcon aria-hidden="true" /> {busy ? 'Checking…' : 'Sign in'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
