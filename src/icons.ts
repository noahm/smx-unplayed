/**
 * Difficulty icons, as inline SVG.
 *
 * Simplified vector recreations of the StepManiaX difficulty glyphs (graduation
 * cap, winged shield, lightning bolt, crown, dual-pad hex, skull & crossbones),
 * one per game mode, color-coded to match. Inlined as markup — no external asset
 * or extra request — and unsized so callers control dimensions via a wrapper.
 */

import type { Mode } from "./data.ts";

export const MODE_ICONS: Record<Mode, string> = {
  // Green graduation cap.
  beginner:
    `<svg viewBox="0 0 24 24" fill="#4ccf2e"><path d="M12 3 22 8 12 13 2 8Z"/>` +
    `<path d="M6.5 10.2v4.1c0 1.4 2.5 2.4 5.5 2.4s5.5-1 5.5-2.4v-4.1L12 13z"/>` +
    `<path d="M21.4 8.4 21 12.7" stroke="#4ccf2e" stroke-width=".9" fill="none"/>` +
    `<circle cx="21" cy="13.6" r="1.05"/></svg>`,
  // Gold winged shield.
  easy:
    `<svg viewBox="0 0 24 24" fill="#f5c01b"><path d="M12 4.7 17.2 6.8v5.1c0 3.1-2.6 5.2-5.2 6.2-2.6-1-5.2-3.1-5.2-6.2V6.8z"/>` +
    `<path d="M6.8 7.6 1.8 6.4l4.9 2.7z"/><path d="M6.8 9.7 2.6 9l4.2 1.9z"/>` +
    `<path d="M17.2 7.6 22.2 6.4l-4.9 2.7z"/><path d="M17.2 9.7 21.4 9l-4.2 1.9z"/></svg>`,
  // Red lightning bolt.
  hard:
    `<svg viewBox="0 0 24 24" fill="#f0303f"><path d="M13.5 2 4 14h6l-1.8 8L20 9.5h-7z"/></svg>`,
  // Purple crown.
  wild:
    `<svg viewBox="0 0 24 24" fill="#8e3cf7"><path d="M3 8.2 6.3 16h11.4L21 8.2l-5 3.8-4-6.2-4 6.2z"/>` +
    `<rect x="6" y="16.8" width="12" height="2.6" rx=".6"/>` +
    `<circle cx="3" cy="8.2" r="1.4"/><circle cx="21" cy="8.2" r="1.4"/><circle cx="12" cy="5" r="1.4"/></svg>`,
  // Cyan dual-pad hex with inward chevrons.
  dual:
    `<svg viewBox="0 0 24 24" fill="none" stroke="#28bfe6" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round">` +
    `<path d="M6.5 6 17.5 6 22 12 17.5 18 6.5 18 2 12z"/>` +
    `<path d="M8.2 9.4 11 12 8.2 14.6"/><path d="M15.8 9.4 13 12 15.8 14.6"/></svg>`,
  // Teal skull & crossbones. The eyes/nose are masked out so they read as true
  // holes on any background (only one full icon ever renders per page).
  full:
    `<svg viewBox="0 0 24 24"><defs><mask id="smxskull"><rect width="24" height="24" fill="#fff"/>` +
    `<circle cx="9.4" cy="9.3" r="1.5" fill="#000"/><circle cx="14.6" cy="9.3" r="1.5" fill="#000"/>` +
    `<path d="M12 11.4 11.1 13.2h1.8z" fill="#000"/></mask></defs>` +
    `<path d="M4.5 16.8 19.5 7.2M4.5 7.2 19.5 16.8" stroke="#2ee0bd" stroke-width="2.1" stroke-linecap="round"/>` +
    `<path d="M12 3.2c-3.9 0-6.4 2.5-6.4 5.9 0 2 1 3.4 2.2 4.3v1.5c0 .8.6 1.4 1.4 1.4h5.6c.8 0 1.4-.6 1.4-1.4v-1.5c1.2-.9 2.2-2.3 2.2-4.3 0-3.4-2.5-5.9-6.4-5.9z" fill="#2ee0bd" mask="url(#smxskull)"/></svg>`,
};
