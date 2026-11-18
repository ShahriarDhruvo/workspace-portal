import { PortalMark } from "@/components/brand";
import { Spinner } from "@/components/ui/spinner";

export function BootScreen({ hint }: { hint: string }) {
  return (
    <div role="status" aria-live="polite" className="flex flex-col items-center gap-5">
      <PortalMark size={36} />
      <span className="flex items-center gap-2 text-13 text-muted-foreground">
        <Spinner aria-hidden="true" />
        {hint}
      </span>
    </div>
  );
}
