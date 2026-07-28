import type { HTMLAttributes, ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/components/ui/utils";

const workbenchSurfaceVariants = cva("workbench-surface", {
  variants: {
    depth: {
      base: "workbench-surface-base",
      panel: "workbench-surface-panel",
      elevated: "workbench-surface-elevated",
      interactive: "workbench-surface-interactive",
    },
    padding: {
      none: "",
      compact: "workbench-surface-compact",
      default: "workbench-surface-default",
      spacious: "workbench-surface-spacious",
    },
  },
  defaultVariants: {
    depth: "panel",
    padding: "default",
  },
});

export type WorkbenchSurfaceProps = HTMLAttributes<HTMLDivElement> &
  VariantProps<typeof workbenchSurfaceVariants>;

export function WorkbenchSurface({ className, depth, padding, ...props }: WorkbenchSurfaceProps) {
  return <div className={cn(workbenchSurfaceVariants({ depth, padding }), className)} {...props} />;
}

export function PanelHeading({
  icon,
  eyebrow,
  title,
  actions,
  className,
}: {
  icon?: ReactNode;
  eyebrow?: string;
  title: string;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("ds-panel-heading", className)}>
      {icon && <span className="ds-panel-heading-icon" aria-hidden="true">{icon}</span>}
      <span className="ds-panel-heading-copy">
        {eyebrow && <span>{eyebrow}</span>}
        <strong>{title}</strong>
      </span>
      {actions && <span className="ds-panel-heading-actions">{actions}</span>}
    </header>
  );
}
