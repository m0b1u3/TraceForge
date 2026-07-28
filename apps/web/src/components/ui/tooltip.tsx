"use client"

import * as React from "react"
import * as TooltipPrimitive from "@radix-ui/react-tooltip"

import { cn } from "@/components/ui/utils"

function TooltipProvider({
  delayDuration = 320,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  )
}

function Tooltip({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "z-50 w-fit max-w-72 origin-(--radix-tooltip-content-transform-origin) rounded-[7px] border border-border bg-popover px-2.5 py-1.5 text-[length:var(--type-label)] font-medium text-balance text-popover-foreground shadow-[var(--shadow-panel)] data-[state=delayed-open]:animate-[tf-tooltip-in_150ms_var(--ease-emphasized)] data-[state=closed]:animate-[tf-popover-out_100ms_var(--ease-standard)]",
          className
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="z-50 size-2.5 translate-y-[-2px] fill-popover" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
