import type { Lane } from "./events";

/** Costs: 4dp under $1, 2dp above ($0.0342 / $12.48). */
export function usd(n: number): string {
  if (!Number.isFinite(n)) return "$—";
  return n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

/** Compact counts for token/turn magnitudes: 4.18M · 210k · 940. */
export function compact(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  return `${Math.round(n)}`;
}

/** Durations: 42s · 4m 12s · 1h 04m. */
export function secs(total: number): string {
  const s = Math.max(0, Math.round(total));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Relative time from an epoch-ms (or ISO) instant: "12s ago", "3m ago". */
export function relTime(when: number | string, now = Date.now()): string {
  const t = typeof when === "string" ? Date.parse(when) : when;
  if (!Number.isFinite(t)) return "—";
  const d = Math.max(0, now - t) / 1000;
  if (d < 5) return "just now";
  if (d < 60) return `${Math.floor(d)}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86_400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86_400)}d ago`;
}

/** Age in ms from an ISO createdAt. */
export function ageMs(createdAt: string, now = Date.now()): number {
  const t = Date.parse(createdAt);
  return Number.isFinite(t) ? Math.max(0, now - t) : 0;
}

export function laneLabel(lane: Lane): string {
  switch (lane) {
    case "todo": return "Todo";
    case "claimed": return "Executing";
    case "parked": return "Parked";
    case "needs_human": return "Needs Human";
  }
}

export function clockTime(atMs: number): string {
  const d = new Date(atMs);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((x) => String(x).padStart(2, "0"))
    .join(":");
}

export function dateTime(atMs: number): string {
  const d = new Date(atMs);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[d.getMonth()]} ${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
