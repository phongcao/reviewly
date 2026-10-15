import { Button } from "@/components/ui/button";
import { WHATS_NEW, type WhatsNewEntry, cmpVersion } from "@/lib/whats-new";
import { useUi } from "@/stores/ui";
import { useWhatsNew } from "@/stores/whats-new";
import { getVersion } from "@tauri-apps/api/app";
import { Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

/**
 * "What's new" panel. Auto-opens ONCE after the app updates — it compares the
 * running version against the last version the user acknowledged (persisted) and
 * shows every release entry in between. A fresh install seeds the marker
 * silently (nothing to announce). Also openable manually from About.
 *
 * Mounted only in the main window (via AppLayout), never the detached chat
 * window. Reads the persisted marker AFTER hydration finishes so the async
 * SQLite load can't be mistaken for a fresh install on launch.
 */
export function WhatsNewDialog() {
  const manualOpen = useUi((s) => s.whatsNewOpen);
  const setManualOpen = useUi((s) => s.setWhatsNewOpen);
  const [current, setCurrent] = useState<string | null>(null);
  const [autoEntries, setAutoEntries] = useState<WhatsNewEntry[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      let version: string;
      try {
        version = await getVersion();
      } catch {
        return;
      }
      if (cancelled) return;
      setCurrent(version);
      const seen = useWhatsNew.getState().lastSeenVersion;
      if (seen === version) return; // already caught up
      if (seen == null) {
        // Fresh install (or first run with this feature) — seed, don't announce.
        useWhatsNew.getState().markSeen(version);
        return;
      }
      const fresh = WHATS_NEW.filter(
        (e) => cmpVersion(e.version, seen) > 0 && cmpVersion(e.version, version) <= 0,
      );
      if (fresh.length === 0) {
        useWhatsNew.getState().markSeen(version);
        return;
      }
      setAutoEntries(fresh);
    };
    // Wait for the persisted marker to hydrate before deciding (getItem is async).
    if (useWhatsNew.persist.hasHydrated()) {
      void run();
      return () => {
        cancelled = true;
      };
    }
    const unsub = useWhatsNew.persist.onFinishHydration(() => void run());
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, []);

  const close = useCallback(() => {
    if (current) useWhatsNew.getState().markSeen(current);
    setAutoEntries(null);
    setManualOpen(false);
  }, [current, setManualOpen]);

  // Manual open shows the latest released entry; auto shows the fresh span.
  const latest = WHATS_NEW.find((e) => !current || cmpVersion(e.version, current) <= 0);
  const entries = autoEntries ?? (manualOpen && latest ? [latest] : null);
  const open = !!entries && entries.length > 0;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!open || !entries) return null;

  const range =
    entries.length === 1
      ? `Version ${entries[0].version}`
      : `Versions ${entries[entries.length - 1].version} – ${entries[0].version}`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      onClick={close}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="What's new"
        onClick={(e) => e.stopPropagation()}
        className="relative flex max-h-[80vh] w-[26rem] flex-col overflow-hidden rounded-2xl border border-border bg-popover shadow-2xl"
      >
        {/* header */}
        <div className="flex items-center gap-2.5 border-b border-hairline px-5 py-4">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/15">
            <Sparkles className="size-4 text-primary" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-medium text-foreground">What's new</h2>
            <p className="truncate text-xs tabular-nums text-muted-foreground">{range}</p>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="ml-auto text-muted-foreground/60 transition-colors hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* body */}
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {entries.map((entry) => (
            <div key={entry.version} className="space-y-2.5">
              {entries.length > 1 && (
                <p className="text-2xs font-medium uppercase tracking-wide text-muted-foreground/55">
                  v{entry.version}
                </p>
              )}
              {entry.items.map((item, i) => (
                <div key={i} className="flex gap-2.5">
                  <span
                    aria-hidden
                    className="mt-[7px] size-1.5 shrink-0 rounded-full bg-primary/70"
                  />
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-foreground">{item.title}</p>
                    {item.detail && (
                      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                        {item.detail}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>

        {/* footer */}
        <div className="border-t border-hairline p-4">
          <Button size="sm" className="w-full shadow-sm" onClick={close}>
            Got it
          </Button>
        </div>
      </div>
    </div>
  );
}
