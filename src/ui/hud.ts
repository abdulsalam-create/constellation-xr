/**
 * Overlay HUD: status, statistics and the selected node's details.
 *
 * Plain DOM rather than a canvas or an in-world panel. On the desktop fallback
 * this is what the user reads; inside an immersive session the DOM overlay is
 * not visible at all, so the node highlight is the only selection feedback
 * there. In-world labels would need an SDF text atlas, which is noted as a
 * limitation rather than half-built.
 */

export interface HudStats {
  nodes: number;
  edges: number;
  fps: number;
  simMs: number;
  alpha: number;
  settled: boolean;
}

export class Hud {
  private readonly statsEl: HTMLElement;
  private readonly detailEl: HTMLElement;
  private readonly statusEl: HTMLElement;

  constructor(root: HTMLElement) {
    this.statsEl = must(root.querySelector<HTMLElement>('[data-hud-stats]'), 'hud stats');
    this.detailEl = must(root.querySelector<HTMLElement>('[data-hud-detail]'), 'hud detail');
    this.statusEl = must(root.querySelector<HTMLElement>('[data-hud-status]'), 'hud status');
  }

  setStats(stats: HudStats): void {
    this.statsEl.textContent =
      `${stats.nodes.toLocaleString()} nodes · ${stats.edges.toLocaleString()} edges · ` +
      `${stats.fps.toFixed(0)} fps · sim ${stats.simMs.toFixed(1)} ms · ` +
      (stats.settled ? 'settled' : `cooling ${(stats.alpha * 100).toFixed(0)}%`);
  }

  setSelection(label: string | null, degree: number, group: string): void {
    if (label === null) {
      this.detailEl.textContent = 'Nothing selected';
      this.detailEl.removeAttribute('data-active');
      return;
    }
    this.detailEl.textContent = `${label} — ${degree} connection${degree === 1 ? '' : 's'} · ${group}`;
    this.detailEl.setAttribute('data-active', 'true');
  }

  setStatus(message: string): void {
    this.statusEl.textContent = message;
  }
}

function must<T>(value: T | null, what: string): T {
  if (value === null) throw new Error(`Missing required element: ${what}`);
  return value;
}

/**
 * Exponentially smoothed frame-rate counter.
 *
 * A raw per-frame reciprocal jitters too much to read; a plain average over a
 * window hides the stutter that actually matters. Exponential smoothing shows
 * sustained drops while staying legible.
 */
export class FpsMeter {
  private value = 60;
  private last = 0;

  sample(now: number): number {
    if (this.last !== 0) {
      const delta = now - this.last;
      if (delta > 0) {
        const instant = 1000 / delta;
        this.value += (instant - this.value) * 0.08;
      }
    }
    this.last = now;
    return this.value;
  }
}
