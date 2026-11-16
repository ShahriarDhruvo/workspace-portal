import type { ReactNode } from "react";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface SectionProps {
  /** For links to the card (/settings#password); its heading is `${id}-title`, which names the region. */
  id: string;
  title: string;
  /** One short line under the title, only when the title alone doesn't say what the card is for. */
  description?: ReactNode;
  /** The card's body: CardContent, then a CardFooter for its buttons (a form of class `contents` may hold both). */
  children: ReactNode;
}

/**
 * A titled card of a page (Settings, a user's page): every such card has the same header, padding and title
 * size, and keeps its buttons in a footer strip, so the pages read alike.
 */
export function Section({ id, title, description, children }: SectionProps) {
  const titleId = `${id}-title`;
  return (
    <Card id={id} role="region" aria-labelledby={titleId} className="scroll-mt-24">
      <CardHeader>
        <CardTitle>
          <h2 id={titleId} className="text-16">
            {title}
          </h2>
        </CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      {children}
    </Card>
  );
}
