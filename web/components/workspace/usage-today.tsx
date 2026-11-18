import type { UsageToday as Usage } from "@/lib/usage";
import { formatCount } from "@/lib/format";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/** Home's secondary card: the user's LLM requests and tokens so far today. */
export function UsageToday({ usage }: { usage: Usage }) {
  const tiles = [
    { label: "Requests", value: usage.requests },
    { label: "Tokens in", value: usage.promptTokens },
    { label: "Tokens out", value: usage.completionTokens },
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 className="text-16">LLM usage today</h2>
        </CardTitle>
        <CardDescription>Your agent&apos;s requests to the LLM since midnight.</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-3 gap-2">
          {tiles.map((tile) => (
            <div key={tile.label} className="flex min-w-0 flex-col gap-1 rounded-md bg-muted/60 px-3 py-2.5">
              <dt className="truncate text-12 text-muted-foreground">{tile.label}</dt>
              <dd className="font-mono text-18 leading-6 font-medium tabular-nums" title={tile.value.toLocaleString("en")}>
                {formatCount(tile.value)}
              </dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}
