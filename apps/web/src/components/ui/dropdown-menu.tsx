import * as React from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { cn } from "@/components/ui/utils";

function DropdownMenu(props: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  return <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

function DropdownMenuTrigger(props: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  return <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

function DropdownMenuContent({ className, sideOffset = 6, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        collisionPadding={12}
        className={cn("z-50 min-w-44 origin-[var(--radix-dropdown-menu-content-transform-origin)] overflow-hidden rounded-[10px] border border-border bg-popover p-1.5 text-popover-foreground shadow-[var(--shadow-panel)] data-[state=open]:animate-[tf-popover-in_180ms_var(--ease-emphasized)] data-[state=closed]:animate-[tf-popover-out_120ms_var(--ease-standard)]", className)}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

function DropdownMenuItem({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Item>) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      className={cn("flex min-h-9 cursor-default items-center gap-2.5 rounded-[7px] px-2.5 py-2 text-[length:var(--type-control)] font-medium text-muted-foreground outline-none select-none transition-colors duration-100 focus:bg-accent focus:text-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-45 [&_svg]:size-4", className)}
      {...props}
    />
  );
}

export { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger };
