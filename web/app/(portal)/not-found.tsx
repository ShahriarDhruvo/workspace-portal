import Link from "next/link";
import { PageMain } from "@/components/layout/page-main";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { HomeIcon } from "@/components/ui/icons";

/**
 * notFound() in a signed-in page (the page of a user who doesn't exist): a card under the top bar, like the pages
 * around it. Addresses with no page at all get the root not-found.tsx, the sign-in screen's card.
 */
export default function PortalNotFound() {
  return (
    <PageMain width="sm">
      <Card>
        <CardHeader>
          <CardTitle>
            <h1 className="text-16">Page not found</h1>
          </CardTitle>
          <CardDescription>There is nothing at this address.</CardDescription>
          <CardAction>
            <Button asChild>
              <Link href="/">
                <HomeIcon />
                Home
              </Link>
            </Button>
          </CardAction>
        </CardHeader>
      </Card>
    </PageMain>
  );
}
