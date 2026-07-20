import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

export const ScrollArea = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function ScrollArea({ className, children, ...props }, ref) {
    return (
      <div ref={ref} className={cn("relative overflow-auto", className)} {...props}>
        {children}
      </div>
    );
  },
);
