import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

const integerFormatter = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
const percentFormatters = new Map<number, Intl.NumberFormat>();
const usdFormatter = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
const dateTimeFormatter = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short",
  timeStyle: "medium",
  timeZone: "America/Sao_Paulo",
});
const dayFormatter = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const relativeTimeFormatter = new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" });

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function formatInteger(value: number): string {
  return integerFormatter.format(value);
}

export function formatPercent(value: number | null, digits = 1): string {
  if (value === null) return "—";
  let formatter = percentFormatters.get(digits);
  if (formatter === undefined) {
    formatter = new Intl.NumberFormat("pt-BR", {
      style: "percent",
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
    percentFormatters.set(digits, formatter);
  }
  return formatter.format(value);
}

export function formatUsd(value: number | null): string {
  return value === null ? "Não configurado" : usdFormatter.format(value);
}

export function formatDateTime(value: string | null): string {
  if (value === null) return "Sem evidência";
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? dateTimeFormatter.format(parsed) : value;
}

export function formatDay(value: string | null): string {
  if (value === null) return "—";
  const parsed = new Date(`${value}T12:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) ? dayFormatter.format(parsed) : value;
}

export function relativeTime(value: string | null, now = new Date()): string {
  if (value === null) return "sem evidência";
  const parsed = new Date(value);
  const seconds = Math.round((parsed.getTime() - now.getTime()) / 1_000);
  if (!Number.isFinite(seconds)) return value;
  const absolute = Math.abs(seconds);
  if (absolute < 60) return relativeTimeFormatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return relativeTimeFormatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 48) return relativeTimeFormatter.format(hours, "hour");
  return relativeTimeFormatter.format(Math.round(hours / 24), "day");
}

export function truncateIdentifier(value: string, start = 8, end = 5): string {
  return value.length <= start + end + 1
    ? value
    : `${value.slice(0, start)}…${value.slice(-end)}`;
}
