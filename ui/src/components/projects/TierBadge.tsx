import { Badge, type BadgeVariant } from "../ui/badge";

// Merge-ladder tier chip — display-only (the ladder climbs on verification
// evidence, never from this UI). One place owns the tier→variant mapping so
// the list page and the detail panel cannot disagree.

export function tierVariant(tier: string): BadgeVariant {
  switch (tier) {
    case "auto": return "ok";
    case "auto-low-risk": return "live";
    case "shadow": return "claude";
    case "human": return "outline";
    default: return "outline"; // unknown/legacy tier reads as the safest
  }
}

export function TierBadge({ tier, cleanStreak }: { tier: string; cleanStreak?: number }) {
  return (
    <Badge variant={tierVariant(tier)} className="uppercase tracking-[0.05em]">
      {tier}
      {tier === "shadow" && (cleanStreak ?? 0) > 0 && (
        <span className="normal-case tracking-normal opacity-80">· streak {cleanStreak}</span>
      )}
    </Badge>
  );
}
