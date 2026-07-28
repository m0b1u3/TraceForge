import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "@radix-ui/react-slot"

import { cn } from "@/components/ui/utils"

const badgeVariants = cva(
  "inline-flex min-h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-[6px] border border-transparent px-2 py-0.5 text-[length:var(--type-label)] font-medium leading-none whitespace-nowrap transition-[color,background-color,border-color] focus-visible:ring-[3px] focus-visible:ring-ring/18 aria-invalid:ring-destructive/20 [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "bg-primary/12 text-primary [a&]:hover:bg-primary/18",
        secondary:
          "bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90",
        destructive:
          "bg-destructive text-white focus-visible:ring-destructive/20 [a&]:hover:bg-destructive/90",
        outline:
          "border-border text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        ghost: "[a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
        link: "text-primary underline-offset-4 [a&]:hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
