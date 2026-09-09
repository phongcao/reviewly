import type { PrContextRef } from "@/lib/ai/attach";
import { useAiChat } from "@/stores/ai-chat";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";

/**
 * Keeps chat attachments in sync between the main window and a detached chat
 * window. Those are separate webviews with separate JS heaps — so separate
 * zustand instances — and `sqlStorage` only reads at hydration. Without this
 * bridge, pinning a snippet in the main window would be invisible to the
 * detached chat that's supposed to receive it.
 *
 * Every mutation broadcasts the resulting *whole* list rather than a delta, so
 * receivers are idempotent and need no merge logic.
 */

const EVENT = "chat:attach";

interface AttachPayload {
  /** Emitting window label — Tauri delivers to the emitter too, so we skip our own. */
  origin: string;
  prKey: string;
  refs: PrContextRef[];
}

function windowLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    return "unknown";
  }
}

function broadcast(prKey: string): void {
  const refs = useAiChat.getState().attachments[prKey] ?? [];
  // `code` isn't persisted but is serializable — send it, so the other window
  // gets the snippet even for ranges it couldn't re-derive from the patch.
  emit(EVENT, { origin: windowLabel(), prKey, refs } satisfies AttachPayload).catch(() => {});
}

export function attachContext(prKey: string, ref: PrContextRef): void {
  useAiChat.getState().attach(prKey, ref);
  broadcast(prKey);
}

export function removeContext(prKey: string, id: string): void {
  useAiChat.getState().removeAttachment(prKey, id);
  broadcast(prKey);
}

export function clearContext(prKey: string): void {
  useAiChat.getState().clearAttachments(prKey);
  broadcast(prKey);
}

/** Mount once per chat surface (AiReview renders in both windows). */
export function useAttachBridge(prKey: string): void {
  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    const me = windowLabel();
    listen<AttachPayload>(EVENT, (e) => {
      const p = e.payload;
      if (p.origin === me || p.prKey !== prKey) return;
      useAiChat.getState().setAttachments(prKey, p.refs);
    }).then((u) => {
      if (alive) unlisten = u;
      else u();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [prKey]);
}
