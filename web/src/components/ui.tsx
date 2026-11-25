import {
  useCallback,
  useEffect,
  useId,
  useRef,
  Children,
  useState,
  type ComponentProps,
  type DependencyList,
  type ReactNode,
} from 'react';
import { confirm } from '@ui-sdk/react/alert-dialog';
import { Button as UiButton } from '@ui-sdk/react/button';
import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@ui-sdk/react/dialog';
import { Field, FieldDescription, FieldLabel } from '@ui-sdk/react/field';
import { Input } from '@ui-sdk/react/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectTrigger,
  SelectValue,
} from '@ui-sdk/react/select';
import { Switch, SwitchThumb } from '@ui-sdk/react/switch';
import { Textarea } from '@ui-sdk/react/textarea';
import { toast } from '@ui-sdk/react/toast';
import { CheckIcon, ChevronDownIcon, ClipboardCopyIcon, XIcon } from 'lucide-react';
import { describeError } from '../api';

export function Button({ children, ...props }: ComponentProps<typeof UiButton>) {
  if (typeof children === 'function') return <UiButton {...props}>{children}</UiButton>;
  const merged: ReactNode[] = [];
  let run = '';
  const flush = () => {
    if (run.trim()) merged.push(<span key={`t${merged.length}`}>{run.trim()}</span>);
    run = '';
  };
  for (const child of Children.toArray(children)) {
    if (typeof child === 'string' || typeof child === 'number') run += String(child);
    else {
      flush();
      merged.push(child);
    }
  }
  flush();
  return <UiButton {...props}>{merged}</UiButton>;
}

export interface Resource<T> {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
  reload: () => Promise<void>;
}

export function useResource<T>(
  fetcher: () => Promise<T>,
  deps: DependencyList,
  options: { intervalMs?: number } = {},
): Resource<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const alive = useRef(true);
  const generation = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const next = await fetcherRef.current();
      if (alive.current && mine === generation.current) {
        setData(next);
        setError(undefined);
      }
    } catch (caught) {
      if (alive.current && mine === generation.current) setError(describeError(caught));
    } finally {
      if (alive.current && mine === generation.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    setLoading(true);
    void reload();
    const timer = options.intervalMs ? setInterval(() => void reload(), options.intervalMs) : undefined;
    return () => {
      alive.current = false;
      if (timer) clearInterval(timer);
    };
  }, [reload, options.intervalMs, ...deps]);

  return { data, error, loading, reload };
}

export const ask = (title: string, description: string, confirmLabel: string): Promise<boolean> =>
  confirm({ title, description, confirmLabel, cancelLabel: 'Cancel' });

export const notify = {
  success: (title: string, description?: string) =>
    toast.success(title, description ? { description } : undefined),
  error: (error: unknown) => toast.error(describeError(error), { duration: 10_000 }),
};

export async function attempt<T>(action: () => Promise<T>, success?: string): Promise<T | undefined> {
  try {
    const result = await action();
    if (success) notify.success(success);
    return result;
  } catch (error) {
    notify.error(error);
    return undefined;
  }
}

export function Notice({
  tone = 'info',
  children,
  title,
}: {
  tone?: 'info' | 'warn' | 'error' | 'ok';
  title?: string;
  children: ReactNode;
}) {
  return (
    <div className="notice" data-tone={tone} role={tone === 'error' ? 'alert' : 'status'}>
      {title ? <strong>{title}</strong> : null}
      <div>{children}</div>
    </div>
  );
}

export function LoadState({ resource, label }: { resource: Resource<unknown>; label: string }) {
  if (resource.error) {
    return (
      <Notice tone="error" title={`Could not load ${label}`}>
        {resource.error}{' '}
        <Button data-size="sm" onClick={() => resource.reload()}>
          Retry
        </Button>
      </Notice>
    );
  }
  if (resource.loading && resource.data === undefined) {
    return (
      <p className="muted" role="status">
        Loading {label}…
      </p>
    );
  }
  return null;
}

type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'muted';

export function Pill({ tone = 'muted', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className="pill" data-tone={tone}>
      {children}
    </span>
  );
}

const HEALTH_TONE: Record<string, Tone> = {
  healthy: 'ok',
  degraded: 'warn',
  auth_required: 'warn',
  error: 'bad',
  disabled: 'muted',
  initializing: 'info',
};

export function HealthPill({ health }: { health: string }) {
  return <Pill tone={HEALTH_TONE[health] ?? 'muted'}>{health.replace('_', ' ')}</Pill>;
}

export function Card({
  title,
  description,
  actions,
  children,
  id,
  level = 2,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  id?: string;
  level?: 2 | 3;
}) {
  const headingId = useId();
  const Heading = `h${level}` as 'h2' | 'h3';
  return (
    <section className="card" aria-labelledby={headingId} id={id}>
      <header className="card-head">
        <div>
          <Heading id={headingId}>{title}</Heading>
          {description ? <p className="muted">{description}</p> : null}
        </div>
        {actions ? <div className="row">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="stat">
      <dt>{label}</dt>
      <dd>{value}</dd>
      {hint ? <small className="muted">{hint}</small> : null}
    </div>
  );
}

export interface Column<T> {
  header: string;
  cell: (row: T) => ReactNode;
  rowHeader?: boolean;
  align?: 'end';
}

export function DataTable<T>({
  caption,
  rows,
  columns,
  rowKey,
  empty,
}: {
  caption: string;
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  empty: string;
}) {
  const captionId = useId();
  if (rows.length === 0) {
    return <p className="empty">{empty}</p>;
  }
  return (
    <div className="table-wrap" role="region" aria-labelledby={captionId} tabIndex={0}>
      <table>
        <caption id={captionId}>{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.header} scope="col" data-align={column.align}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((column) =>
                column.rowHeader ? (
                  <th key={column.header} scope="row">
                    {column.cell(row)}
                  </th>
                ) : (
                  <td key={column.header} data-label={column.header} data-align={column.align}>
                    {column.cell(row)}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    clearTimeout(timer.current);
    setState((await writeClipboard(text)) ? 'copied' : 'failed');
    timer.current = setTimeout(() => setState('idle'), 2000);
  }
  return (
    <span className="copy">
      <Button type="button" data-size="sm" aria-label={`Copy ${label}`} onClick={copy}>
        {state === 'copied' ? <CheckIcon aria-hidden="true" /> : <ClipboardCopyIcon aria-hidden="true" />}
        Copy
      </Button>
      <span role="status" className="copy-tip">
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : ''}
      </span>
    </span>
  );
}

export function CodeBlock({ text, label }: { text: string; label: string }) {
  return (
    <div className="code">
      <div className="code-bar">
        <span className="muted">{label}</span>
        <CopyButton text={text} label={label} />
      </div>
      <pre tabIndex={0}>
        <code>{text}</code>
      </pre>
    </div>
  );
}

export function TextField({
  label,
  value,
  onChange,
  description,
  type = 'text',
  required,
  placeholder,
  autoComplete,
  mono,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  description?: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
  autoComplete?: string;
  mono?: boolean;
}) {
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <Input
        type={type}
        value={value}
        onValueChange={(next: string) => onChange(next)}
        required={required}
        placeholder={placeholder}
        autoComplete={autoComplete}
        spellCheck={false}
        className={mono ? 'mono' : undefined}
      />
      {description ? <FieldDescription>{description}</FieldDescription> : null}
    </Field>
  );
}

export function TextAreaField({
  label,
  value,
  onChange,
  description,
  required,
  placeholder,
  rows = 4,
  mono,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  description?: string;
  required?: boolean;
  placeholder?: string;
  rows?: number;
  mono?: boolean;
}) {
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <Textarea
        value={value}
        onValueChange={(next: string) => onChange(next)}
        required={required}
        placeholder={placeholder}
        rows={rows}
        spellCheck={false}
        className={mono ? 'mono' : undefined}
      />
      {description ? <FieldDescription>{description}</FieldDescription> : null}
    </Field>
  );
}

export interface Option {
  value: string;
  label: string;
}

export function SelectField({
  label,
  value,
  onChange,
  options,
  placeholder = 'Select…',
  description,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Option[];
  placeholder?: string;
  description?: string;
}) {
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <Select
        items={options}
        value={options.some((o) => o.value === value) ? value : null}
        onValueChange={(next: string | null) => onChange(next ?? '')}
        placeholder={placeholder}
      >
        <SelectTrigger>
          <SelectValue />
          <ChevronDownIcon aria-hidden="true" />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
              <SelectItemIndicator>
                <CheckIcon aria-hidden="true" />
              </SelectItemIndicator>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {description ? <FieldDescription>{description}</FieldDescription> : null}
    </Field>
  );
}

export function SwitchField({
  label,
  checked,
  onChange,
  description,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  description?: string;
  disabled?: boolean;
}) {
  return (
    <Field>
      <label data-slot="label" className="switch-row">
        <span>{label}</span>
        <Switch checked={checked} onCheckedChange={(next: boolean) => onChange(next)} disabled={disabled}>
          <SwitchThumb />
        </Switch>
      </label>
      {description ? <FieldDescription>{description}</FieldDescription> : null}
    </Field>
  );
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={(next: boolean) => !next && onClose()}>
      <DialogBackdrop />
      <DialogContent className="modal" data-wide={wide ? '' : undefined}>
        <div data-slot="stack" className="modal-head">
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </div>
        <div className="modal-body">{children}</div>
        <DialogClose aria-label="Close dialog" className="modal-x">
          <XIcon aria-hidden="true" />
        </DialogClose>
      </DialogContent>
    </Dialog>
  );
}

export function formatTime(iso: string | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

export function formatRelative(iso: string | undefined): string {
  if (!iso) return '—';
  const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (abs < 60) return rtf.format(seconds, 'second');
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(seconds / 3600), 'hour');
  return rtf.format(Math.round(seconds / 86_400), 'day');
}

export const formatMs = (ms: number): string =>
  ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`;

export const formatPercent = (ratio: number): string => `${(ratio * 100).toFixed(1)}%`;

export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${Math.floor(seconds % 60)}s`;
}

export const json = (value: unknown): string => JSON.stringify(value, null, 2);

export function parseJsonObject(text: string, what: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${what} must be valid JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${what} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

export const lines = (text: string): string[] =>
  text
    .split(/\r?\n|,/)
    .map((line) => line.trim())
    .filter(Boolean);
