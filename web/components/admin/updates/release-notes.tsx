"use client";

import type { RefObject } from "react";
import { returnFocus } from "@/lib/focus";
import type { ReleaseNotes } from "@portal/core/wire";
import { parseReleaseNotes, type NoteBlock, type NoteSpan } from "@/lib/release-notes";
import { LocalTime } from "@/components/local-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RightUpIcon } from "@/components/ui/icons";

/** Spans as text: bold and code only. Never HTML. */
function Spans({ spans }: { spans: NoteSpan[] }) {
  return spans.map((span, index) =>
    span.code ? (
      <code key={index} className="rounded-sm bg-muted px-1 font-mono text-12">
        {span.text}
      </code>
    ) : span.bold ? (
      <strong key={index} className="font-medium text-foreground">
        {span.text}
      </strong>
    ) : (
      <span key={index}>{span.text}</span>
    ),
  );
}

/** Consecutive list items as one list. */
function group(blocks: NoteBlock[]): Array<NoteBlock | { kind: "list"; items: NoteBlock[] }> {
  const out: Array<NoteBlock | { kind: "list"; items: NoteBlock[] }> = [];
  for (const block of blocks) {
    const last = out.at(-1);
    if (block.kind === "item" && last?.kind === "list") last.items.push(block);
    else if (block.kind === "item") out.push({ kind: "list", items: [block] });
    else out.push(block);
  }
  return out;
}

/** Only https links to the notes' page; anything else is shown without a link. */
function safeUrl(url: string): string | null {
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** Whose notes the dialog shows: the card's product, the row's version and its GitHub release. */
export interface ReleaseNotesTarget {
  name: string;
  version: string;
  notes: ReleaseNotes;
}

interface ReleaseNotesDialogProps {
  /** Kept while the dialog closes, so its content doesn't change mid-animation. */
  target: ReleaseNotesTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The Release notes button that opened it (the dialog has no Trigger of its own). */
  returnFocusTo: RefObject<HTMLElement | null>;
}

/**
 * One release's notes, the same for the engine and the agents (each Package images row's "Release notes"): its
 * Breaking changes badge and date, the notes as simple text (lib/release-notes.ts; never HTML), and the release on
 * GitHub for the whole of a long changelog. The notes scroll inside the dialog, which never outgrows the screen.
 */
export function ReleaseNotesDialog({ target, open, onOpenChange, returnFocusTo }: ReleaseNotesDialogProps) {
  const url = target ? safeUrl(target.notes.url) : null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onCloseAutoFocus={returnFocus(returnFocusTo)} className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-2xl">
        {target ? (
          <>
            <DialogHeader className="pr-8">
              <DialogTitle className="text-16 leading-6">
                {target.name} <span className="font-mono">{target.version}</span>
              </DialogTitle>
              <DialogDescription asChild>
                <div className="flex flex-wrap items-center gap-2 text-13">
                  {target.notes.breaking ? <Badge variant="destructive">Breaking changes</Badge> : null}
                  {target.notes.publishedAt ? (
                    <span>
                      Released <LocalTime at={target.notes.publishedAt} relative />
                    </span>
                  ) : (
                    <span>{target.notes.title}</span>
                  )}
                </div>
              </DialogDescription>
            </DialogHeader>
            <div className="-mx-4 flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-4 text-13 text-muted-foreground">
              {group(parseReleaseNotes(target.notes.body, 60, target.version)).map((block, index) =>
                block.kind === "list" ? (
                  <ul key={index} className="flex list-disc flex-col gap-1 pl-5">
                    {block.items.map((item, itemIndex) => (
                      <li key={itemIndex} className="wrap-anywhere">
                        <Spans spans={item.spans} />
                      </li>
                    ))}
                  </ul>
                ) : block.kind === "heading" ? (
                  <h3 key={index} className="mt-2 text-13 font-medium text-foreground first:mt-0">
                    <Spans spans={block.spans} />
                  </h3>
                ) : (
                  <p key={index} className="wrap-anywhere">
                    <Spans spans={block.spans} />
                  </p>
                ),
              )}
            </div>
            {url ? (
              <DialogFooter>
                <Button variant="outline" asChild>
                  <a href={url} target="_blank" rel="noopener noreferrer">
                    On GitHub
                    <RightUpIcon data-icon="inline-end" />
                  </a>
                </Button>
              </DialogFooter>
            ) : null}
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
