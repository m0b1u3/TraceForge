import type { SVGProps } from "react";
import { cn } from "@/components/ui/utils";

export type BrandMarkProps = SVGProps<SVGSVGElement> & {
  size?: "sm" | "md" | "lg";
};

/**
 * Two trace inputs converge through a forged junction and continue as one
 * verified path. This is a product mark, not a generic interface icon.
 */
export function BrandMark({ className, size = "md", ...props }: BrandMarkProps) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      className={cn("brand-mark", `brand-mark-${size}`, className)}
      aria-hidden="true"
      {...props}
    >
      <path d="M7 8h5l5 8M7 24h5l5-8M22 16h4" />
      <circle cx="5" cy="8" r="2.25" />
      <circle cx="5" cy="24" r="2.25" />
      <path className="brand-mark-junction" d="m17 11 5 5-5 5-5-5 5-5Z" />
      <circle cx="28" cy="16" r="2.25" />
    </svg>
  );
}
