import { openWorkspace } from "@/lib/actions/admin";
import type { ButtonSize, ButtonVariant } from "@/components/ui/button";
import { RightUpIcon } from "@/components/ui/icons";
import { SubmitButton } from "@/components/ui/submit-button";

/** Points the admin's session at this user's workspace and goes there. */
export function OpenWorkspaceForm({
  userId,
  label = "Open workspace",
  variant = "outline",
  size = "sm",
}: {
  userId: number;
  label?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return (
    <form action={openWorkspace}>
      <input type="hidden" name="userId" value={userId} />
      <SubmitButton variant={variant} size={size} icon={<RightUpIcon />}>
        {label}
      </SubmitButton>
    </form>
  );
}
