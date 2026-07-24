import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import {
  Activity,
  Bot,
  ChartNoAxesCombined,
  CircleDollarSign,
  Database,
  Gauge,
  History,
  ListChecks,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  ServerCog,
  Store,
  Sun,
} from "lucide-react";
import { useEffect, useState } from "react";

import { api } from "../lib/api.js";
import { cn, relativeTime } from "../lib/utils.js";
import { DatabaseBadge } from "./status.js";
import { Badge, Button } from "./ui.js";

const navigation = [
  { to: "/", label: "Control Room", icon: Gauge },
  { to: "/retailers", label: "Varejistas", icon: Store },
  { to: "/runs", label: "Execuções", icon: ListChecks },
  { to: "/automation", label: "Automação", icon: Bot },
  { to: "/limits", label: "Limites e custos", icon: CircleDollarSign },
  { to: "/index", label: "Índice e evidência", icon: ChartNoAxesCombined },
  { to: "/jobs", label: "Ações", icon: History },
  { to: "/system", label: "Sistema", icon: ServerCog },
] as const;

function useTheme() {
  const [dark, setDark] = useState(() =>
    localStorage.getItem("control-room-theme") === "dark"
      || (localStorage.getItem("control-room-theme") === null
        && window.matchMedia("(prefers-color-scheme: dark)").matches));
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("control-room-theme", dark ? "dark" : "light");
  }, [dark]);
  return [dark, setDark] as const;
}

export function AppShell() {
  const [collapsed, setCollapsed] = useState(false);
  const [dark, setDark] = useTheme();
  const meta = api.useMeta();
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  return (
    <div className="min-h-screen bg-canvas text-ink">
      <aside className={cn(
        "fixed inset-y-0 left-0 z-40 hidden border-r border-sidebar-border bg-sidebar text-sidebar-ink transition-[width] lg:flex lg:flex-col",
        collapsed ? "w-[76px]" : "w-[248px]",
      )}>
        <div className="flex h-20 items-center gap-3 border-b border-sidebar-border px-4">
          <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent text-accent-contrast shadow-sm">
            <Activity className="size-5" aria-hidden="true" />
          </div>
          {!collapsed && (
            <div className="min-w-0">
              <p className="truncate text-sm font-bold tracking-tight">BPP Control Room</p>
              <p className="mt-0.5 truncate text-[11px] text-sidebar-muted">Operação auditável</p>
            </div>
          )}
        </div>
        <nav aria-label="Navegação principal" className="flex-1 space-y-1 p-3">
          {navigation.map((item) => {
            const active = item.to === "/" ? pathname === "/" : pathname.startsWith(item.to);
            return (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  "flex h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                  active
                    ? "bg-sidebar-active text-white"
                    : "text-sidebar-muted hover:bg-sidebar-hover hover:text-white",
                  collapsed && "justify-center px-0",
                )}
                title={collapsed ? item.label : undefined}
              >
                <item.icon className="size-[18px] shrink-0" aria-hidden="true" />
                {!collapsed && <span>{item.label}</span>}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-sidebar-border p-3">
          <Button
            variant="ghost"
            className="w-full justify-center text-sidebar-muted hover:bg-sidebar-hover hover:text-white"
            onClick={() => setCollapsed((value) => !value)}
            aria-label={collapsed ? "Expandir navegação" : "Recolher navegação"}
          >
            {collapsed ? <PanelLeftOpen className="size-4" /> : <><PanelLeftClose className="size-4" /> Recolher</>}
          </Button>
        </div>
      </aside>

      <div className={cn("transition-[padding]", collapsed ? "lg:pl-[76px]" : "lg:pl-[248px]")}>
        <header className="sticky top-0 z-30 border-b border-border bg-canvas/92 backdrop-blur-xl">
          <div className="flex min-h-16 items-center justify-between gap-4 px-4 md:px-6 xl:px-8">
            <div className="flex min-w-0 items-center gap-3">
              <Database className="hidden size-4 text-muted sm:block" aria-hidden="true" />
              {meta.data ? (
                <>
                  <DatabaseBadge value={meta.data.database.state} />
                  <span className="hidden truncate font-mono text-xs text-muted md:inline">{meta.data.database.label}</span>
                  {meta.data.database.dataVersion !== null && (
                    <span className="hidden text-xs text-muted xl:inline">rev. {meta.data.database.dataVersion}</span>
                  )}
                </>
              ) : (
                <Badge tone="neutral">Conectando…</Badge>
              )}
            </div>
            <div className="flex items-center gap-2">
              {meta.data && (
                <Badge tone={meta.data.application.actionsEnabled ? "warning" : "info"}>
                  {meta.data.application.actionsEnabled ? "Ações habilitadas" : "Modo observador"}
                </Badge>
              )}
              <span className="hidden text-xs text-muted sm:inline">
                atualizado {relativeTime(meta.data?.generatedAt ?? null)}
              </span>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setDark((value) => !value)}
                aria-label={dark ? "Usar tema claro" : "Usar tema escuro"}
              >
                {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
              </Button>
            </div>
          </div>
          <nav aria-label="Navegação móvel" className="flex gap-1 overflow-x-auto border-t border-border px-3 py-2 lg:hidden">
            {navigation.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  "inline-flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium",
                  (item.to === "/" ? pathname === "/" : pathname.startsWith(item.to))
                    ? "bg-accent text-accent-contrast"
                    : "text-muted hover:bg-subtle hover:text-ink",
                )}
              >
                <item.icon className="size-4" /> {item.label}
              </Link>
            ))}
          </nav>
        </header>
        <main className="mx-auto max-w-[1680px] px-4 py-6 md:px-6 xl:px-8 xl:py-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
