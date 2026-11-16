"use client";

import type { EngineImage, EngineRelease } from "@/lib/engine-types";
import { compareEngineVersions } from "@/lib/engine-updates";
import { formatBytes } from "@/lib/format";
import { GuardedButton } from "@/components/common/guarded-button";
import { LocalTime } from "@/components/local-time";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

// The LLM engine card's two tables, each scrolling sideways inside its own card on a narrow screen: the releases
// in the registry (any can be installed) and the engine images on the LLM server (old ones can be removed).

const TABLE = "[&_tr>*:first-child]:pl-3 [&_tr>*:last-child]:pr-3";
const HEAD = "h-8 text-12 text-muted-foreground";

const shortDigest = (digest: string | null) => (digest ? digest.replace(/^sha256:/, "").slice(0, 12) : "—");

interface ReleasesTableProps {
  releases: EngineRelease[];
  current: string | null;
  /** Digests of the images on the LLM server: those versions install without a download. */
  onServer: ReadonlySet<string>;
  blockedReason: string | null;
  onInstall: (release: EngineRelease, from: HTMLElement) => void;
}

/** The registry's releases, newest first, each with its notes' date and a button to install it. */
export function ReleasesTable({ releases, current, onServer, blockedReason, onInstall }: ReleasesTableProps) {
  const sorted = [...releases].sort((a, b) => compareEngineVersions(b.version, a.version));
  return (
    <Card size="sm" className="gap-0 py-0">
      <Table className={TABLE}>
        <TableHeader>
          <TableRow>
            <TableHead scope="col" className={HEAD}>
              Version
            </TableHead>
            <TableHead scope="col" className={HEAD}>
              Released
            </TableHead>
            <TableHead scope="col" className={HEAD}>
              Image
            </TableHead>
            <TableHead scope="col" className={HEAD}>
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((release) => {
            const isCurrent = release.version === current;
            const newer = current !== null && compareEngineVersions(release.version, current) > 0;
            return (
              <TableRow key={release.version}>
                <TableCell>
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-13">{release.version}</span>
                    {isCurrent ? <Badge>Running</Badge> : null}
                    {release.latest ? <Badge variant="outline">latest</Badge> : null}
                    {release.notes?.breaking ? <Badge variant="destructive">Breaking changes</Badge> : null}
                  </span>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {release.notes?.publishedAt ? <LocalTime at={release.notes.publishedAt} relative /> : "—"}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {release.digest && onServer.has(release.digest) ? "On the server" : "Downloads first"}
                </TableCell>
                <TableCell className="w-0 text-right">
                  {isCurrent ? null : (
                    <GuardedButton
                      variant="outline"
                      size="sm"
                      blockedReason={blockedReason}
                      onClick={(event) => onInstall(release, event.currentTarget)}
                    >
                      {newer ? "Update…" : "Switch…"}
                    </GuardedButton>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Card>
  );
}

interface ImagesTableProps {
  images: EngineImage[];
  removeBlocker: (image: EngineImage) => string | null;
  onRemove: (image: EngineImage, from: HTMLElement) => void;
}

/** The engine images on the LLM server: the one that runs, the one before it (rollback), older ones to remove. */
export function ImagesTable({ images, removeBlocker, onRemove }: ImagesTableProps) {
  if (images.length === 0) return <p className="text-13 text-muted-foreground">None.</p>;
  return (
    <Card size="sm" className="gap-0 py-0">
      <Table className={TABLE}>
        <TableHeader>
          <TableRow>
            {["Version", "Digest", "Size", "Created"].map((heading) => (
              <TableHead key={heading} scope="col" className={HEAD}>
                {heading}
              </TableHead>
            ))}
            <TableHead scope="col" className={HEAD}>
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {images.map((image) => (
            <TableRow key={image.id}>
              <TableCell>
                <span className="flex items-center gap-2">
                  <span className="font-mono text-13">{image.version ?? "unknown"}</span>
                  {image.current ? <Badge>Running</Badge> : null}
                  {image.previous ? <Badge variant="outline">Previous</Badge> : null}
                </span>
              </TableCell>
              <TableCell className="font-mono text-12 text-muted-foreground" title={image.digest ?? undefined}>
                {shortDigest(image.digest)}
              </TableCell>
              <TableCell className="text-muted-foreground">{image.sizeBytes === null ? "—" : formatBytes(image.sizeBytes)}</TableCell>
              <TableCell className="text-muted-foreground">{image.createdAt ? <LocalTime at={image.createdAt} relative /> : "—"}</TableCell>
              <TableCell className="w-0 text-right">
                <GuardedButton
                  variant="outline"
                  size="sm"
                  blockedReason={removeBlocker(image)}
                  onClick={(event) => onRemove(image, event.currentTarget)}
                >
                  Remove…
                </GuardedButton>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}
