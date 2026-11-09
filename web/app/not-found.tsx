import Link from "next/link";
import { Brand } from "@/components/brand";
import { buttonClass } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-base px-6">
      <Brand size="lg" />
      <div className="flex flex-col items-center gap-1 text-center">
        <h1 className="text-16 font-medium">Page not found</h1>
        <p className="text-14 text-fg-muted">There is nothing at this address.</p>
      </div>
      <Link href="/" className={buttonClass("outline")}>
        Go to the portal
      </Link>
    </main>
  );
}
