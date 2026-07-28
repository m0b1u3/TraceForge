import * as React from "react"

import { cn } from "@/components/ui/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-10 w-full min-w-0 rounded-[8px] border border-input bg-card px-3 text-[length:var(--type-control)] text-foreground shadow-[var(--shadow-sm)] outline-none transition-[background-color,border-color,box-shadow] duration-150 placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-[length:var(--type-control)] file:font-medium file:text-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-45",
        "hover:border-foreground/20 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/16",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20",
        className
      )}
      {...props}
    />
  )
}

export { Input }
