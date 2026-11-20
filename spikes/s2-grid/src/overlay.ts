/** The reserved validation channel (DESIGN §6.7), drawn the same way in either grid. */
import type { Issue } from "./sheet-model.ts";

export const ISSUE_COLORS = { error: "#d32020", warning: "#d98a00" } as const;

export function drawIssue(
  ctx: CanvasRenderingContext2D,
  rect: { x: number; y: number; width: number; height: number },
  issue: Issue,
  /** 0..1 while a newly introduced error pulses, else 0. */
  pulse = 0,
): void {
  const color = ISSUE_COLORS[issue.level];
  ctx.save();
  if (pulse > 0) {
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.25 * pulse;
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    ctx.globalAlpha = 1;
  }
  // Inset dashed outline: inside the cell so it never fights user borders.
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(rect.x + 2.5, rect.y + 2.5, rect.width - 5, rect.height - 5);
  // Corner flag.
  ctx.setLineDash([]);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(rect.x + rect.width - 8, rect.y + 1);
  ctx.lineTo(rect.x + rect.width - 1, rect.y + 1);
  ctx.lineTo(rect.x + rect.width - 1, rect.y + 8);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** Type gutter: a thin colored stripe on column A. */
export function drawGutter(ctx: CanvasRenderingContext2D, rect: { x: number; y: number; height: number }, color: string): void {
  ctx.save();
  ctx.fillStyle = color;
  ctx.fillRect(rect.x, rect.y, 4, rect.height);
  ctx.restore();
}

/** Tracks pulses for cells where an edit introduced a new error. One pulse each. */
export class Pulses {
  private started = new Map<string, number>();
  readonly ms = 700;
  start(r: number, c: number): void {
    this.started.set(`${r},${c}`, performance.now());
  }
  amount(r: number, c: number): number {
    const t = this.started.get(`${r},${c}`);
    if (t === undefined) return 0;
    const a = 1 - (performance.now() - t) / this.ms;
    if (a <= 0) this.started.delete(`${r},${c}`);
    return Math.max(0, Math.sin(Math.PI * Math.min(1, (performance.now() - t) / this.ms)));
  }
  get active(): boolean {
    return this.started.size > 0;
  }
}

/** Scroll top to bottom programmatically and report frame timing. */
export async function scrollBench(
  rows: number,
  scrollToRow: (row: number) => void,
  seconds = 6,
): Promise<{ frames: number; fps: number; p95: number; worst: number }> {
  const times: number[] = [];
  const t0 = performance.now();
  let last = t0;
  await new Promise<void>((done) => {
    const step = (now: number) => {
      times.push(now - last);
      last = now;
      const f = (now - t0) / (seconds * 1000);
      scrollToRow(Math.min(rows - 1, Math.floor(f * rows)));
      if (f < 1) requestAnimationFrame(step);
      else done();
    };
    requestAnimationFrame(step);
  });
  times.shift();
  const sorted = [...times].sort((a, b) => a - b);
  return {
    frames: times.length,
    fps: times.length / seconds,
    p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
    worst: sorted[sorted.length - 1] ?? 0,
  };
}
