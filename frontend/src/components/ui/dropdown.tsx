'use client';
import * as React from 'react';
import * as D from '@radix-ui/react-dropdown-menu';
import { cn } from '@/lib/utils';
const DropdownMenu = D.Root; const DropdownMenuTrigger = D.Trigger; const DropdownMenuGroup = D.Group;
const DropdownMenuContent = React.forwardRef<React.ElementRef<typeof D.Content>, React.ComponentPropsWithoutRef<typeof D.Content>>(({ className, sideOffset = 4, ...props }, ref) => (
  <D.Portal><D.Content ref={ref} sideOffset={sideOffset} className={cn('z-50 min-w-[10rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0', className)} {...props} /></D.Portal>
));
DropdownMenuContent.displayName = 'DropdownMenuContent';
const DropdownMenuItem = React.forwardRef<React.ElementRef<typeof D.Item>, React.ComponentPropsWithoutRef<typeof D.Item> & { destructive?: boolean }>(({ className, destructive, ...props }, ref) => <D.Item ref={ref} className={cn('relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:size-4', destructive && 'text-destructive focus:text-destructive', className)} {...props} />);
DropdownMenuItem.displayName = 'DropdownMenuItem';
const DropdownMenuLabel = ({ className, ...props }: React.ComponentPropsWithoutRef<typeof D.Label>) => <D.Label className={cn('px-2 py-1.5 text-xs font-semibold text-muted-foreground', className)} {...props} />;
const DropdownMenuSeparator = ({ className, ...props }: React.ComponentPropsWithoutRef<typeof D.Separator>) => <D.Separator className={cn('-mx-1 my-1 h-px bg-muted', className)} {...props} />;
export { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuGroup };
