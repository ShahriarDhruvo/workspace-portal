import type { ComponentProps } from "react";
import { openWorkspace } from "@/lib/actions/admin";
import { SubmitButton } from "@/components/forms/submit-button";
import { RightUpIcon } from "@/components/ui/icons";

/**
 * Points the admin's session at this user's workspace and goes there. For the admin's own row it leaves
 * any workspace the session is viewing and goes to /workspace.
 */
export function OpenWorkspaceForm({
  userId,
  label = "Open workspace",
  variant = "outline",
  size = "sm",
}: {
  userId: number;
  label?: string;
} & Pick<ComponentProps<typeof SubmitButton>, "variant" | "size">) {
  return (
    <form action={openWorkspace}>
      <input type="hidden" name="userId" value={userId} />
      <SubmitButton variant={variant} size={size} icon={<RightUpIcon />}>
        {label}
      </SubmitButton>
    </form>
  );
}
