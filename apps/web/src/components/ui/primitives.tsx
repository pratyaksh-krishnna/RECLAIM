import { useState, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/cn';

/* Night Desk primitives. Flat panels, hairline rules, one metal. */

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 rounded-md text-sm font-medium transition-[background-color,border-color,color,opacity,transform] duration-200 ease-desk active:translate-y-[1px] disabled:opacity-40 disabled:pointer-events-none disabled:active:translate-y-0',
  {
    variants: {
      variant: {
        default: 'bg-brass text-white hover:bg-brass/90',
        outline: 'border border-rule bg-panel text-ink hover:border-ash/45 hover:bg-raise',
        ghost: 'text-ash hover:bg-ink/[0.055] hover:text-ink',
        destructive: 'border border-crimson/40 bg-crimson/10 text-crimson hover:bg-crimson/20',
        success: 'bg-sage text-white hover:bg-sage/90',
      },
      size: { sm: 'h-8 px-3', md: 'h-9 px-4', xs: 'h-7 px-2 text-xs' },
    },
    defaultVariants: { variant: 'default', size: 'md' },
  },
);

export function Button({
  className,
  variant,
  size,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-panel border border-rule bg-panel shadow-panel', className)} {...props} />;
}
export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex items-center gap-2 px-5 pb-3 pt-4', className)} {...props} />;
}
export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn('eyebrow', className)} {...props} />;
}
export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-5 pb-5', className)} {...props} />;
}

/* ------------------------------- typography ------------------------------- */

export function Eyebrow({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('eyebrow', className)} {...props} />;
}

export function PageHeader({
  title,
  lede,
  children,
}: {
  title: string;
  lede?: string;
  children?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end gap-x-4 gap-y-2">
      <div>
        <h1 className="widest text-[1.35rem] font-semibold leading-none tracking-tight text-ink">{title}</h1>
        {lede && <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ash">{lede}</p>}
      </div>
      {children && <div className="ml-auto flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

/* --------------------------------- badges --------------------------------- */

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-2xs font-medium leading-5',
  {
    variants: {
      tone: {
        neutral: 'border-rule bg-ink/[0.042] text-ash',
        blue: 'border-steel/30 bg-steel/10 text-steel',
        green: 'border-sage/30 bg-sage/10 text-sage',
        amber: 'border-marigold/30 bg-marigold/10 text-marigold',
        red: 'border-crimson/35 bg-crimson/10 text-crimson',
        violet: 'border-peri/35 bg-peri/10 text-peri',
        brass: 'border-brass/35 bg-brass/10 text-brass',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);
export function Badge({
  className,
  tone,
  ...props
}: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

/** A value the deterministic side owns: an id, an action name, a rule key. */
export function Chip({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded border border-rule bg-ink/[0.042] px-1.5 py-0.5 font-mono text-2xs text-ink/85',
        className,
      )}
      {...props}
    />
  );
}

/* -------------------------------- tooltip --------------------------------- */

export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="group/tip relative inline-flex">
      {children}
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 w-64 -translate-x-1/2 rounded-md border border-ink/10 bg-ink px-3 py-2 text-xs leading-relaxed text-paper opacity-0 shadow-lift transition-opacity duration-150 group-hover/tip:opacity-100"
      >
        {label}
      </span>
    </span>
  );
}

/* ------------------------------- instruments ------------------------------ */

/**
 * A confidence reading. An agent's number is never presented bare — it is
 * always shown as a partial bar, so a 0.42 reads as thin at a glance instead
 * of looking like a fact with a decimal point.
 */
export function Meter({ value, tone = 'steel', label }: { value: number; tone?: 'steel' | 'brass'; label?: string }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <span className="inline-flex items-center gap-2 align-middle">
      <span className="relative block h-1 w-14 overflow-hidden rounded-full bg-ink/10">
        <span
          className={cn(
            'absolute inset-0 origin-left rounded-full transition-transform duration-500 ease-desk',
            tone === 'brass' ? 'bg-brass' : 'bg-steel',
          )}
          style={{ transform: `scaleX(${pct / 100})` }}
        />
      </span>
      <span className={cn('tnum text-2xs', tone === 'brass' ? 'text-brass' : 'text-steel')}>{pct}%</span>
      {label && <span className="text-2xs text-ash">{label}</span>}
    </span>
  );
}

/**
 * Money. Brass, expanded, tabular — the ledger voice. Nothing an agent wrote is
 * ever set this way.
 */
export function Money({
  value,
  size = 'md',
  className,
}: {
  value: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
}) {
  const sizes = {
    sm: 'text-sm',
    md: 'text-lg',
    lg: 'text-3xl',
    xl: 'text-[2.75rem] leading-[1.05]',
  } as const;
  return (
    <span className={cn('widest tnum font-semibold text-brass', sizes[size], className)}>{value}</span>
  );
}

/** Says who produced the block it sits above. */
export function Source({ kind, detail }: { kind: 'ledger' | 'policy' | 'agent' | 'human'; detail?: string | undefined }) {
  const label = { ledger: 'ledger', policy: 'policy engine', agent: 'agent', human: 'human' }[kind];
  const tone = kind === 'agent' ? 'text-steel' : kind === 'human' ? 'text-ink/70' : 'text-brass';
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn('eyebrow', tone)}>{label}</span>
      {detail && <span className="font-mono text-2xs text-ash">{detail}</span>}
    </span>
  );
}

/**
 * A long note written by an agent. Two things are wrong with showing one raw:
 * it buries the controls under a wall of text, and the model's `**emphasis**`
 * markers show up as literal asterisks. So the labels are set in the interface's
 * own voice and the body is clamped until the reader asks for the rest.
 */
export function Note({ text, label }: { text: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 420 || text.split('\n').length > 8;

  return (
    <div>
      {label && <Eyebrow className="text-steel">{label}</Eyebrow>}
      <div className={cn('relative mt-1', long && !open && 'max-h-36 overflow-hidden')}>
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink/85">
          {text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
            part.startsWith('**') && part.endsWith('**') && part.length > 4 ? (
              <strong key={i} className="font-semibold text-ink">
                {part.slice(2, -2)}
              </strong>
            ) : (
              <span key={i}>{part}</span>
            ),
          )}
        </p>
        {long && !open && (
          <span className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-panel to-transparent" />
        )}
      </div>
      {long && (
        <button
          className="mt-1.5 text-2xs text-ash transition-colors hover:text-brass"
          onClick={() => setOpen(!open)}
        >
          {open ? 'Show less' : 'Read the whole note'}
        </button>
      )}
    </div>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center gap-1.5 px-6 py-14 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      {hint && <p className="max-w-sm text-xs leading-relaxed text-ash">{hint}</p>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <span className={cn('block animate-breathe rounded bg-ink/[0.06]', className)} />;
}

/**
 * Loading is shaped like the thing that is coming, not like a spinner — the
 * page does not jump when the data lands.
 */
export function Loading({ shape = 'panel' }: { shape?: 'panel' | 'case' }) {
  if (shape === 'case') {
    return (
      <div aria-busy="true" aria-label="Opening the case file">
        <div className="mb-6 flex items-center gap-3">
          <Skeleton className="h-6 w-56" />
          <Skeleton className="h-5 w-24 rounded-full" />
        </div>
        <div className="grid items-start gap-4 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            {[0, 1].map((i) => (
              <div key={i} className="rounded-panel border border-rule bg-panel p-5">
                <Skeleton className="h-3 w-32" />
                <Skeleton className="mt-4 h-5 w-48" />
                <Skeleton className="mt-3 h-3 w-full" />
                <Skeleton className="mt-2 h-3 w-4/5" />
              </div>
            ))}
          </div>
          <div className="rounded-panel border border-rule bg-panel p-5">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-4 h-8 w-40" />
            <div className="mt-6 space-y-3">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-3 w-full" />
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div aria-busy="true" className="space-y-4">
      <Skeleton className="h-6 w-48" />
      <div className="rounded-panel border border-rule bg-panel p-5">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="mt-4 h-9 w-64" />
        <Skeleton className="mt-4 h-3 w-full" />
      </div>
    </div>
  );
}

/* --------------------------------- shared --------------------------------- */

export const STATE_TONES: Record<string, 'neutral' | 'blue' | 'green' | 'amber' | 'red' | 'violet'> = {
  detected: 'neutral',
  diagnosed: 'blue',
  planned: 'blue',
  pending_policy: 'amber',
  pending_approval: 'amber',
  executing: 'blue',
  waiting: 'neutral',
  re_evaluating: 'blue',
  recovered: 'green',
  stopped: 'neutral',
  escalated: 'red',
  lost: 'red',
  disputed: 'red',
};

/** Plain-language names for the states, for anywhere the raw key is too terse. */
export const STATE_LABELS: Record<string, string> = {
  detected: 'Detected',
  diagnosed: 'Diagnosed',
  planned: 'Planned',
  pending_policy: 'At the policy gate',
  pending_approval: 'Awaiting approval',
  executing: 'Executing',
  waiting: 'Waiting',
  re_evaluating: 'Re-evaluating',
  recovered: 'Recovered',
  stopped: 'Stopped',
  escalated: 'Escalated',
  lost: 'Lost',
  disputed: 'Disputed',
};

export const CAUSE_LABELS: Record<string, string> = {
  expired_card: 'Expired card',
  insufficient_funds: 'Insufficient funds',
  hard_decline: 'Hard decline',
  auth_required: 'Auth required',
  processor_error: 'Processor error',
  procurement_delay: 'Procurement delay',
  invoice_dispute_suspected: 'Dispute suspected',
  cash_flow_stress: 'Cash-flow stress',
  habitual_late_payer: 'Habitual late payer',
  unknown: 'Unknown',
};

/** One date format across the desk: 21 Nov 2026, and 5:30 am when the time matters. */
export function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}
export function formatMoment(iso: string): string {
  const d = new Date(iso);
  return `${formatDay(iso)}, ${d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}`;
}
