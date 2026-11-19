"use client";

import { useState } from "react";
import { CopyButton, SecretValue } from "@/components/common/secret-value";
import { Section } from "@/components/layout/section";
import { Button } from "@/components/ui/button";
import { CardContent } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDownIcon } from "@/components/ui/icons";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

const KEY = "YOUR_API_KEY";

/** A first request in each language, written for `baseUrl` and `model`. */
const EXAMPLES: ReadonlyArray<{ id: string; label: string; code: (baseUrl: string, model: string) => string }> = [
  {
    id: "curl",
    label: "curl",
    code: (baseUrl, model) => `curl ${baseUrl}/chat/completions \\
  -H "Authorization: Bearer ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "${model}", "messages": [{"role": "user", "content": "Hello"}]}'`,
  },
  {
    id: "python",
    label: "Python",
    code: (baseUrl, model) => `from openai import OpenAI

client = OpenAI(
    base_url="${baseUrl}",
    api_key="${KEY}",
)
reply = client.chat.completions.create(
    model="${model}",
    messages=[{"role": "user", "content": "Hello"}],
)
print(reply.choices[0].message.content)`,
  },
  {
    id: "javascript",
    label: "JavaScript",
    code: (baseUrl, model) => `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${baseUrl}",
  apiKey: "${KEY}",
});
const reply = await client.chat.completions.create({
  model: "${model}",
  messages: [{ role: "user", content: "Hello" }],
});
console.log(reply.choices[0].message.content);`,
  },
];

interface ConnectProps {
  /** The LLM API's OpenAI base URL at the address the browser uses: "https://portal/llm/api/v1". */
  baseUrl: string;
  /** The model to ask for; null when the gateway could not say. */
  model: string | null;
  /** Show the examples from the start: for someone who has no key yet. */
  examplesOpen: boolean;
}

/** What a program needs besides a key: where the API is and which model to ask for, then a first request to copy. */
export function Connect({ baseUrl, model, examplesOpen }: ConnectProps) {
  const [language, setLanguage] = useState("curl");
  const code = EXAMPLES.find((example) => example.id === language)!.code(baseUrl, model ?? "MODEL");
  return (
    <Section
      id="connect"
      title="Connect your software"
      description="Anything that speaks the OpenAI API works. In an editor, choose the OpenAI-compatible provider, then enter these and one of your keys."
    >
      <CardContent className="flex flex-col gap-4">
        <dl className="grid gap-4">
          <Value label="Base URL" value={baseUrl} />
          {model ? <Value label="Model" value={model} /> : null}
        </dl>
        <Collapsible defaultOpen={examplesOpen} className="flex flex-col gap-3">
          <CollapsibleTrigger asChild>
            <Button type="button" variant="ghost" size="sm" className="group -ml-2.5 self-start text-muted-foreground">
              <ChevronDownIcon className="transition-transform group-data-[state=closed]:-rotate-90" />
              Code examples
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              {/* A press on the language already chosen would clear the choice: there is always one. */}
              <ToggleGroup type="single" variant="outline" spacing={0} value={language} onValueChange={(next) => next && setLanguage(next)} aria-label="Language">
                {EXAMPLES.map((example) => (
                  <ToggleGroupItem key={example.id} value={example.id} className="data-[state=off]:text-muted-foreground">
                    {example.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <CopyButton value={code} />
            </div>
            <pre className="overflow-x-auto rounded-md border bg-muted px-3 py-2.5 font-mono text-12 leading-5">
              <code>{code}</code>
            </pre>
            <p className="text-12 text-muted-foreground">
              Software that speaks Anthropic&apos;s API takes <code className="font-mono text-foreground">{baseUrl.replace(/\/v1$/, "")}</code> as its base URL.
            </p>
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Section>
  );
}

function Value({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <dt className="text-12 text-muted-foreground">{label}</dt>
      <dd>
        <SecretValue value={value} />
      </dd>
    </div>
  );
}
