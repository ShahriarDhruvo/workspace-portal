import type { ReactNode } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";

/** A form-level error banner (role="alert", so screen readers announce it). */
export function FormError({ children }: { children: ReactNode }) {
  return (
    <Alert variant="destructive">
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}
