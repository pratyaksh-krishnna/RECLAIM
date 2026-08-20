import { type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/cn';

/* shadcn-style primitives, hand-copied per the shadcn model */

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 rounded-md text-sm font-medium transition-colors disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
  {
    variants: {
      variant: {
        default: 'bg-accent text-white hover:bg-accent/90',
        outline: 'border border-border bg-white hover:bg-surface',
        ghost: 'hover:bg-black/5',
        destructive: 'bg-bad text-white hover:bg-bad/90',
        success: 'bg-good text-white hover:bg-good/90',
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
  return <div className={cn('rounded-lg border border-border bg-white shadow-sm', className)} {...props} />;
}
export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-4 pt-4 pb-2', className)} {...props} />;
}
export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn('text-sm font-semibold tracking-tight text-muted uppercase', className)} {...props} />;
}
export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-4 pb-4', className)} {...props} />;
}

const badgeVariants = cva('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', {
  variants: {
    tone: {
      neutral: 'bg-black/5 text-ink',
      blue: 'bg-accent/10 text-accent',
      green: 'bg-good/10 text-good',
      amber: 'bg-warn/10 text-warn',
      red: 'bg-bad/10 text-bad',
      violet: 'bg-purple-600/10 text-purple-700',
    },
  },
  defaultVariants: { tone: 'neutral' },
});
export function Badge({
  className,
  tone,
  ...props
}: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="group relative inline-flex">
      {children}
      <span className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1.5 w-64 -translate-x-1/2 rounded-md bg-ink px-3 py-2 text-xs text-white opacity-0 shadow-lg transition-opacity group-hover:opacity-100">
        {label}
      </span>
    </span>
  );
}

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
