import * as Dialog from "@radix-ui/react-dialog";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { BookOpen, Info, X } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "../lib/utils.js";

export function Card({ className, ...props }: ComponentProps<"section">) {
  return <section className={cn("rounded-2xl border border-border bg-surface shadow-card", className)} {...props} />;
}

export function CardHeader({ className, ...props }: ComponentProps<"header">) {
  return <header className={cn("flex items-start justify-between gap-4 px-5 pt-5", className)} {...props} />;
}

export function CardContent({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("px-5 pb-5 pt-4", className)} {...props} />;
}

export function CardTitle({ className, ...props }: ComponentProps<"h2">) {
  return <h2 className={cn("text-sm font-semibold tracking-tight text-ink", className)} {...props} />;
}

export function CardDescription({ className, ...props }: ComponentProps<"p">) {
  return <p className={cn("mt-1 text-sm leading-5 text-muted", className)} {...props} />;
}

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        primary: "bg-accent px-3.5 py-2 text-accent-contrast hover:bg-accent-strong",
        secondary: "border border-border bg-surface px-3.5 py-2 text-ink hover:bg-subtle",
        ghost: "px-2.5 py-1.5 text-muted hover:bg-subtle hover:text-ink",
        danger: "bg-critical px-3.5 py-2 text-white hover:brightness-95",
      },
      size: {
        sm: "h-8",
        md: "h-10",
        icon: "size-9 p-0",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export interface ButtonProps extends ComponentProps<"button">, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Component = asChild ? Slot : "button";
  return <Component className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold leading-none",
  {
    variants: {
      tone: {
        neutral: "border-border bg-subtle text-muted-strong",
        info: "border-info/25 bg-info/10 text-info-strong",
        good: "border-good/25 bg-good/10 text-good-strong",
        warning: "border-warning/25 bg-warning/10 text-warning-strong",
        critical: "border-critical/25 bg-critical/10 text-critical-strong",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export function Badge({
  className,
  tone,
  ...props
}: ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

export function ProgressBar({
  value,
  tone = "accent",
  label,
  className,
}: {
  value: number;
  tone?: "accent" | "good" | "warning" | "critical";
  label: string;
  className?: string;
}) {
  const bounded = Math.max(0, Math.min(1, value));
  const toneClass = {
    accent: "bg-accent",
    good: "bg-good",
    warning: "bg-warning",
    critical: "bg-critical",
  }[tone];
  return (
    <div
      className={cn("h-2.5 overflow-hidden rounded-full bg-subtle", className)}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(bounded * 100)}
    >
      <div className={cn("h-full rounded-full transition-[width]", toneClass)} style={{ width: `${bounded * 100}%` }} />
    </div>
  );
}

export function Select(props: ComponentProps<"select">) {
  return (
    <select
      {...props}
      className={cn(
        "h-10 rounded-lg border border-border bg-surface px-3 text-sm text-ink outline-none focus:ring-2 focus:ring-accent",
        props.className,
      )}
    />
  );
}

export function Input(props: ComponentProps<"input">) {
  return (
    <input
      {...props}
      className={cn(
        "h-10 rounded-lg border border-border bg-surface px-3 text-sm text-ink outline-none placeholder:text-muted focus:ring-2 focus:ring-accent",
        props.className,
      )}
    />
  );
}

export function Table({ className, ...props }: ComponentProps<"table">) {
  return <table className={cn("w-full border-separate border-spacing-0 text-sm", className)} {...props} />;
}

export function TableHead({ className, ...props }: ComponentProps<"th">) {
  return <th className={cn("border-b border-border px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-muted", className)} {...props} />;
}

export function TableCell({ className, ...props }: ComponentProps<"td">) {
  return <td className={cn("border-b border-border/70 px-3 py-3 align-middle text-ink", className)} {...props} />;
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col justify-between gap-4 md:flex-row md:items-end">
      <div>
        {eyebrow && <p className="mb-2 text-xs font-bold uppercase tracking-[0.18em] text-accent">{eyebrow}</p>}
        <h1 className="text-2xl font-semibold tracking-tight text-ink md:text-3xl">{title}</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted md:text-base">{description}</p>
      </div>
      {actions && <div className="shrink-0">{actions}</div>}
    </div>
  );
}

export function EvidenceDialog({
  source,
  rule,
  code,
  cutoff,
}: {
  source: string;
  rule: string;
  code?: string;
  cutoff?: string | null;
}) {
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <Button variant="ghost" size="sm" className="-mr-2">
          <Info className="size-4" aria-hidden="true" />
          Como é determinado?
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-slate-950/35 backdrop-blur-[2px]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,34rem)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-surface p-6 shadow-2xl">
          <div className="flex items-start justify-between gap-4">
            <div>
              <Dialog.Title className="text-lg font-semibold text-ink">Origem da evidência</Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-muted">
                O painel exibe a regra operacional, não uma interpretação editorial.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label="Fechar">
                <X className="size-4" />
              </Button>
            </Dialog.Close>
          </div>
          <dl className="mt-5 grid gap-4 text-sm">
            <div>
              <dt className="font-semibold text-ink">Fonte</dt>
              <dd className="mt-1 text-muted">{source}</dd>
            </div>
            <div>
              <dt className="font-semibold text-ink">Regra</dt>
              <dd className="mt-1 leading-6 text-muted">{rule}</dd>
            </div>
            {cutoff && (
              <div>
                <dt className="font-semibold text-ink">Corte da leitura</dt>
                <dd className="mt-1 font-mono text-xs text-muted">{cutoff}</dd>
              </div>
            )}
            {code && (
              <div>
                <dt className="flex items-center gap-2 font-semibold text-ink"><BookOpen className="size-4" /> Código relacionado</dt>
                <dd className="mt-1 break-all rounded-lg bg-subtle px-3 py-2 font-mono text-xs text-muted-strong">{code}</dd>
              </div>
            )}
          </dl>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
