// GET /llm/v1/media: what the portal's media tools are told of the AI server's image and media models now
// (list_media_models). The registry (media.json), the models loaded this moment, which start without a wait, and the
// video that holds the server, if one does.
import type { VideoHold } from "@portal/core";
import type { MediaRegistry } from "@portal/harnesses";

export interface MediaCatalog {
  kinds: MediaRegistry;
  /** The models the AI server has loaded now (llama-swap's /running); null when it cannot say. */
  loaded: string[] | null;
  /** The video being made, which every other generation waits behind; null when none. */
  videoHold: VideoHold | null;
}

/** The models llama-swap has running and ready at `upstreamUrl`; null when it does not answer like llama-swap. */
export async function fetchLoadedModels(upstreamUrl: string, apiKey: string): Promise<string[] | null> {
  try {
    const response = await fetch(`${upstreamUrl}/running`, { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {}, signal: AbortSignal.timeout(3_000) });
    if (!response.ok) return null;
    const { running } = ((await response.json()) ?? {}) as { running?: unknown };
    if (!Array.isArray(running)) return null;
    return running.flatMap((entry: unknown) => {
      const { model, state } = (entry ?? {}) as { model?: unknown; state?: unknown };
      return typeof model === "string" && (state === undefined || state === "ready") ? [model] : [];
    });
  } catch {
    return null;
  }
}
