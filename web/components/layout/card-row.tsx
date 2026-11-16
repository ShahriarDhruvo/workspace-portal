import type { ReactNode } from "react";
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";

/**
 * A settings row inside a Card (a shadcn/ui Item): title and explanation on the left, controls on the right,
 * rows split by soft rules. The controls wrap under the text on narrow screens.
 */
export function CardRow({ title, children, action }: { title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <Item className="gap-x-6 gap-y-3 rounded-none border-0 border-b border-border-faint px-4 py-3 last:border-b-0">
      <ItemContent className="min-w-0 basis-64 gap-0.5">
        <ItemTitle className="line-clamp-none">{title}</ItemTitle>
        {/* A paragraph: phrasing content only (lines of a list as block spans). */}
        {children ? <ItemDescription className="line-clamp-none text-13 wrap-anywhere">{children}</ItemDescription> : null}
      </ItemContent>
      {action ? <ItemActions className="shrink-0">{action}</ItemActions> : null}
    </Item>
  );
}
