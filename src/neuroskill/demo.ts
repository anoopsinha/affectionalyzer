import { frameAt } from './signal';
import type { DaemonStatus, EegBands, LinkState } from './types';

/**
 * An in-page stand-in for the daemon client, for the deployed demo.
 *
 * A static host has no daemon to talk to, and `tools/mock-daemon.ts` is a Node
 * process, so a deployed build would otherwise open on "No daemon credentials
 * found" and sit there. This generates the same frames in the browser from the
 * same signal module, at the same ~8 Hz.
 *
 * It matches `NeuroSkillClient`'s shape rather than sharing an interface with
 * it, so `main.ts` treats the two identically and nothing downstream knows which
 * it has. What it is NOT is a pretend headset: the status it reports says
 * "Simulated", because a demo that dressed itself up as a live Muse would be the
 * one dishonest thing in an app built around not overclaiming.
 */

const HZ = 8;

type Handlers = {
  bands: (b: EegBands) => void;
  status: (s: DaemonStatus) => void;
  quality: (q: string[]) => void;
  battery: (pct: number) => void;
  link: (state: LinkState, detail?: string) => void;
};

export interface DemoOptions {
  /** Distinguishes this subject's private signal from the other's. */
  seed: number;
  /** Shown wherever a headset name would be. */
  device: string;
  /** Sample the shared signal this late, so this subject follows. */
  lagMs?: number;
}

export class DemoSource {
  private listeners: { [K in keyof Handlers]: Set<Handlers[K]> } = {
    bands: new Set(),
    status: new Set(),
    quality: new Set(),
    battery: new Set(),
    link: new Set(),
  };
  private timer: number | null = null;
  private sampleCount = 0;

  constructor(private opts: DemoOptions) {}

  get host(): string {
    return 'demo';
  }

  get baseUrl(): string {
    return 'demo://local';
  }

  on<K extends keyof Handlers>(event: K, fn: Handlers[K]): () => void {
    this.listeners[event].add(fn);
    return () => this.listeners[event].delete(fn);
  }

  private emit<K extends keyof Handlers>(event: K, ...args: Parameters<Handlers[K]>): void {
    for (const fn of this.listeners[event]) (fn as (...a: unknown[]) => void)(...args);
  }

  private status(): DaemonStatus {
    return {
      state: 'connected',
      device_name: this.opts.device,
      device_kind: 'simulated',
      device_id: this.opts.device,
      sample_count: this.sampleCount,
      battery: 100,
      device_error: null,
      target_display_name: this.opts.device,
      channel_names: ['TP9', 'AF7', 'AF8', 'TP10'],
      channel_quality: ['good', 'good', 'good', 'good'],
      eeg_sample_rate_hz: 256,
      retry_attempt: 0,
      retry_countdown_secs: 0,
    };
  }

  connect(): void {
    if (this.timer !== null) return;
    this.emit('link', 'open');
    this.emit('status', this.status());
    this.timer = window.setInterval(() => {
      this.sampleCount += Math.round(256 / HZ);
      this.emit(
        'bands',
        frameAt(Date.now(), {
          seed: this.opts.seed,
          coupling: 0.5,
          lagMs: this.opts.lagMs ?? 0,
          hz: HZ,
        }),
      );
    }, 1000 / HZ);
  }

  disconnect(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.emit('link', 'closed');
  }

  async fetchStatus(): Promise<DaemonStatus | null> {
    return this.status();
  }

  async retryConnect(): Promise<boolean> {
    return true;
  }
}
