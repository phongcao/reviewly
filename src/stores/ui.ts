import { sqlStorage } from "@/lib/sql-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";

export type DiffView = "unified" | "split" | "layered" | "guided";

/** The two ways a diff can be laid out. "layered" and "guided" are review modes
 * on top of one of these, not layouts of their own. */
export type DiffLayout = "unified" | "split";

interface UiState {
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  togglePalette: () => void;
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  toggleSettings: () => void;

  aboutOpen: boolean;
  setAboutOpen: (open: boolean) => void;

  /** Manual "What's new" open (the panel also auto-opens once after an update). */
  whatsNewOpen: boolean;
  setWhatsNewOpen: (open: boolean) => void;

  sidebarCollapsed: boolean;
  toggleSidebar: () => void;

  diffView: DiffView;
  setDiffView: (v: DiffView) => void;
  toggleDiffView: () => void;
  /** Last inline/side-by-side choice, so layered review can keep rendering the
   * diff the way the reviewer likes it instead of forcing unified. */
  diffLayout: DiffLayout;

  focusMode: boolean;
  setFocusMode: (v: boolean) => void;
  toggleFocusMode: () => void;

  /** Shrink the PR header and layer briefing to one line each, so the file
   * tree and diff get the height. */
  compactChrome: boolean;
  toggleCompactChrome: () => void;

  /** Zoom level. 1 = default. Stored as a multiplier applied to html root font-size. */
  zoom: number;
  setZoom: (z: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
}

const ZOOM_STEPS = [0.75, 0.85, 0.95, 1, 1.1, 1.2, 1.35, 1.5, 1.75, 2];

function snapZoom(z: number, dir: 1 | -1): number {
  const i = ZOOM_STEPS.findIndex((v) => Math.abs(v - z) < 0.001);
  if (i === -1) return dir === 1 ? 1.1 : 0.95;
  const next = ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, i + dir))];
  return next;
}

export const useUi = create<UiState>()(
  persist(
    (set) => ({
      paletteOpen: false,
      setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
      togglePalette: () => set((s) => ({ paletteOpen: !s.paletteOpen })),
      settingsOpen: false,
      setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
      toggleSettings: () => set((s) => ({ settingsOpen: !s.settingsOpen })),

      aboutOpen: false,
      setAboutOpen: (aboutOpen) => set({ aboutOpen }),

      whatsNewOpen: false,
      setWhatsNewOpen: (whatsNewOpen) => set({ whatsNewOpen }),

      sidebarCollapsed: false,
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

      diffView: "unified",
      diffLayout: "unified",
      setDiffView: (diffView) =>
        set(
          diffView === "unified" || diffView === "split"
            ? { diffView, diffLayout: diffView }
            : { diffView },
        ),
      // ⌘B cycles unified ↔ split only (layered/guided are explicit toggles).
      toggleDiffView: () =>
        set((s) => {
          // Inside layered review, flip the layout *within* the mode — ⌘B must
          // not throw the reviewer out of the layers they're working through.
          if (s.diffView === "layered") {
            return { diffLayout: s.diffLayout === "split" ? "unified" : "split" };
          }
          const next = s.diffView === "split" ? "unified" : "split";
          return { diffView: next, diffLayout: next };
        }),

      focusMode: false,
      setFocusMode: (focusMode) => set({ focusMode }),
      toggleFocusMode: () => set((s) => ({ focusMode: !s.focusMode })),

      compactChrome: false,
      toggleCompactChrome: () => set((s) => ({ compactChrome: !s.compactChrome })),

      zoom: 1,
      setZoom: (zoom) => set({ zoom }),
      zoomIn: () => set((s) => ({ zoom: snapZoom(s.zoom, 1) })),
      zoomOut: () => set((s) => ({ zoom: snapZoom(s.zoom, -1) })),
      resetZoom: () => set({ zoom: 1 }),
    }),
    {
      name: "reviewly.ui",
      storage:
        sqlStorage<
          Pick<
            UiState,
            "diffView" | "diffLayout" | "sidebarCollapsed" | "zoom" | "focusMode" | "compactChrome"
          >
        >(),
      // Persist genuine prefs; transient flags (palette/about) stay in memory.
      partialize: (s) => ({
        diffView: s.diffView,
        diffLayout: s.diffLayout,
        sidebarCollapsed: s.sidebarCollapsed,
        zoom: s.zoom,
        focusMode: s.focusMode,
        compactChrome: s.compactChrome,
      }),
    },
  ),
);
