import type { EngineRelease } from "@/lib/engine-types";
import { parseReleaseNotes, type NoteBlock, type NoteSpan } from "@/lib/release-notes";
import { LocalTime } from "@/components/local-time";
import { Badge } from "@/components/ui/badge";
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

/** One release's notes: its version, date and a "Breaking changes" badge, then the notes as simple text. */
export function ReleaseNotes({ release }: { release: EngineRelease }) {
  const notes = release.notes;
  const url = notes ? safeUrl(notes.url) : null;
  return (
    <article className="flex flex-col gap-2">
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h4 className="font-mono text-13 font-medium">{release.version}</h4>
        {notes?.breaking ? <Badge variant="destructive">Breaking changes</Badge> : null}
        {notes?.publishedAt ? (
          <span className="text-12 text-muted-foreground">
            <LocalTime at={notes.publishedAt} relative />
          </span>
        ) : null}
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto inline-flex items-center gap-1 text-12 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            On GitHub
            <RightUpIcon className="size-3.5" />
          </a>
        ) : null}
      </header>
      {notes ? (
        <div className="flex flex-col gap-1.5 text-13 text-muted-foreground">
          {group(parseReleaseNotes(notes.body, 60, release.version)).map((block, index) =>
            block.kind === "list" ? (
              <ul key={index} className="flex list-disc flex-col gap-1 pl-5">
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex} className="wrap-anywhere">
                    <Spans spans={item.spans} />
                  </li>
                ))}
              </ul>
            ) : block.kind === "heading" ? (
              <h5 key={index} className="mt-1 text-12 font-medium text-foreground">
                <Spans spans={block.spans} />
              </h5>
            ) : (
              <p key={index} className="wrap-anywhere">
                <Spans spans={block.spans} />
              </p>
            ),
          )}
        </div>
      ) : (
        <p className="text-13 text-muted-foreground">No release notes were found for this version.</p>
      )}
    </article>
  );
}
