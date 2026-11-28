"use client";

import { useState } from "react";
import type { UsageToday as Usage } from "@/lib/usage";
import { formatCount } from "@/lib/format";
import { usePoll } from "@/components/common/use-poll";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const REFRESH_MS = 30_000;

/**
 * Home's secondary card: the user's requests to the AI server (text, images and media) and their tokens so far today,
 * read again every half minute. A failed read keeps the last numbers.
 */
export function UsageToday({ initial }: { initial: Usage }) {
  const [usage, setUsage] = useState(initial);
  usePoll<Usage>("/api/usage/today", REFRESH_MS, (result) => {
    if (result.ok) setUsage(result.data);
  });
  const tiles = [
    { label: "Requests", value: usage.requests },
    { label: "Tokens in", value: usage.promptTokens },
    { label: "Tokens out", value: usage.completionTokens },
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2 className="text-16">AI usage today</h2>
        </CardTitle>
        <CardDescription>
          Your requests to the AI server since midnight, images and media included, from your workspace and your API keys.
        </CardDescription>
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
