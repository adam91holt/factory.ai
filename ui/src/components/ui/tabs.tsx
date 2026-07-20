import {
  createContext,
  useContext,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { cn } from "../../lib/utils";

interface TabsCtx {
  value: string;
  setValue: (v: string) => void;
}

const Ctx = createContext<TabsCtx | null>(null);

export function Tabs({
  defaultValue,
  value: controlled,
  onValueChange,
  className,
  children,
}: {
  defaultValue?: string;
  value?: string;
  onValueChange?: (v: string) => void;
  className?: string;
  children: ReactNode;
}) {
  const [inner, setInner] = useState(defaultValue ?? "");
  const value = controlled ?? inner;
  const setValue = (v: string): void => {
    setInner(v);
    onValueChange?.(v);
  };
  return (
    <Ctx.Provider value={{ value, setValue }}>
      <div className={cn("flex flex-col gap-2", className)}>{children}</div>
    </Ctx.Provider>
  );
}

export function TabsList({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="tablist"
      className={cn("inline-flex w-fit items-center gap-0.5 rounded-lg border border-line bg-bg0 p-0.5", className)}
      {...props}
    />
  );
}

export function TabsTrigger({
  value,
  className,
  children,
}: {
  value: string;
  className?: string;
  children: ReactNode;
}) {
  const ctx = useContext(Ctx);
  const active = ctx?.value === value;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={() => ctx?.setValue(value)}
      className={cn(
        "rounded-md px-2.5 py-1 font-mono text-[11px] transition-colors duration-100",
        active ? "border border-line2 bg-bg2 text-fg" : "border border-transparent text-fg-faint hover:text-fg-dim",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function TabsContent({
  value,
  className,
  children,
}: {
  value: string;
  className?: string;
  children: ReactNode;
}) {
  const ctx = useContext(Ctx);
  if (ctx?.value !== value) return null;
  return <div role="tabpanel" className={className}>{children}</div>;
}
