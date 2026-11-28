import type { ComponentProps } from "react";
import { openWorkspace } from "@/lib/actions/admin";
import { SubmitButton } from "@/components/forms/submit-button";
import { RightUpIcon } from "@/components/ui/icons";

/**
 * Points the admin's session at this user's workspace and goes there. For the admin's own row it leaves
 * any workspace the session is viewing and goes to Home. `compact`, for a table row: below a desktop width the button
 * reads "Open", so the row's name keeps its room.
 */
export function OpenWorkspaceForm({
  userId,
  label = "Open workspace",
  variant = "outline",
  size = "sm",
  compact = false,
}: {
  userId: number;
  label?: string;
  compact?: boolean;
} & Pick<ComponentProps<typeof SubmitButton>, "variant" | "size">) {
  return (
    <form action={openWorkspace}>
      <input type="hidden" name="userId" value={userId} />
      <SubmitButton variant={variant} size={size} icon={<RightUpIcon />} aria-label={compact ? label : undefined}>
        {compact ? (
          <>
            <span className="lg:hidden">Open</span>
            <span className="max-lg:hidden">{label}</span>
          </>
        ) : (
          label
        )}
      </SubmitButton>
    </form>
  );
}
