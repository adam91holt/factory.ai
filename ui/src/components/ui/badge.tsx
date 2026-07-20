import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-md border px-1.5 py-px font-mono text-[10.5px] leading-4 whitespace-nowrap",
  {
    variants: {
      variant: {
        default: "border-line bg-bg2 text-fg-dim",
        outline: "border-line2 bg-transparent text-fg-dim",
        live: "border-live/35 bg-live/10 text-live",
        ok: "border-ok/35 bg-ok/10 text-ok",
        err: "border-err/35 bg-err/10 text-err",
        parked: "border-parked/35 bg-parked/10 text-parked",
        human: "border-human/35 bg-human/10 text-human",
        claude: "border-claude/35 bg-claude/10 text-claude",
        codex: "border-codex/35 bg-codex/10 text-codex",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export type BadgeVariant = VariantProps<typeof badgeVariants>["variant"];

export function Badge({
  className,
  variant,
  ...props
}: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
