import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "@radix-ui/react-slot"

import { cn } from "@/components/ui/utils"

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-[8px] text-[13px] font-medium leading-none whitespace-nowrap outline-none transition-[background-color,border-color,color,box-shadow,transform,opacity] duration-150 ease-out active:translate-y-px focus-visible:ring-[3px] focus-visible:ring-ring/18 disabled:pointer-events-none disabled:translate-y-0 disabled:opacity-40 aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "border border-transparent bg-cta font-semibold text-cta-foreground shadow-[var(--shadow-sm)] hover:bg-cta-hover hover:shadow-[0_3px_10px_color-mix(in_srgb,var(--cta)_20%,transparent)] disabled:bg-secondary disabled:font-medium disabled:text-muted-foreground disabled:shadow-none",
        destructive:
          "border border-destructive/25 bg-destructive/10 text-destructive hover:bg-destructive/16 focus-visible:ring-destructive/20",
        outline:
          "border border-border bg-card/60 text-foreground shadow-[var(--shadow-sm)] hover:border-input hover:bg-accent",
        secondary:
          "border border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/75 hover:text-foreground",
        ghost: "border border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 py-2 has-[>svg]:px-3.5",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-9 gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "h-11 px-6 has-[>svg]:px-4",
        icon: "size-10",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-9",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }

// forwardRef is required: Radix Slot (asChild triggers) composes a ref onto
// this component, and React 18 drops refs given to plain function components,
// which leaves floating popups without a measured anchor.
const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "default", size = "default", asChild = false, ...props },
  ref,
) {
  const Comp = asChild ? Slot : "button"

  return (
    <Comp
      ref={ref}
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
})

export { Button, buttonVariants }
