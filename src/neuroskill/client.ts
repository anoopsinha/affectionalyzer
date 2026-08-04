import type {
  BatteryPayload,
  DaemonEvent,
  DaemonStatus,
  EegBands,
  LinkState,
  SignalQuality,
} from './types';

export interface NeuroSkillConfig {
  port: number;
  token: string;
}

type Handlers = {
  bands: (b: EegBands) => void;
  status: (s: DaemonStatus) => void;
  quality: (q: string[]) => void;
  battery: (pct: number) => void;
  link: (state: LinkState, detail?: string) => void;
};

type Listener<K extends keyof Handlers> = Handlers[K];

/**
 * WebSocket client for the skill-daemon event stream.
 *
 * Reconnects with capped exponential backoff, because a Muse over BLE drops
 * often enough that a dashboard which needs a manual refresh is useless.
 */
export class NeuroSkillClient {
  private ws: WebSocket | null = null;
  private listeners: { [K in keyof Handlers]: Set<Listener<K>> } = {
    bands: new Set(),
    status: new Set(),
    quality: new Set(),
    battery: new Set(),
    link: new Set(),
  };
  private retries = 0;
  private retryTimer: number | null = null;
  private stopped = false;

  constructor(private config: NeuroSkillConfig) {}

  get baseUrl(): string {
    return `http://127.0.0.1:${this.config.port}`;
  }

  on<K extends keyof Handlers>(event: K, fn: Listener<K>): () => void {
    this.listeners[event].add(fn);
    return () => this.listeners[event].delete(fn);
  }

  private emit<K extends keyof Handlers>(event: K, ...args: Parameters<Handlers[K]>) {
    for (const fn of this.listeners[event]) {
      (fn as (...a: unknown[]) => void)(...args);
    }
  }

  connect(): void {
    this.stopped = false;
    this.openSocket();
  }

  disconnect(): void {
    this.stopped = true;
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.emit('link', 'closed');
  }

  /** Swap credentials and reconnect — used by the settings panel. */
  reconfigure(config: NeuroSkillConfig): void {
    this.config = config;
    this.retries = 0;
    this.ws?.close();
    this.ws = null;
    this.connect();
  }

  private openSocket(): void {
    const { port, token } = this.config;
    this.emit('link', 'connecting');

    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${port}/v1/events?token=${encodeURIComponent(token)}`);
    } catch (err) {
      this.emit('link', 'error', err instanceof Error ? err.message : String(err));
      this.scheduleRetry();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.retries = 0;
      this.emit('link', 'open');
    };

    ws.onmessage = (ev) => this.handleMessage(ev.data);

    ws.onerror = () => {
      // The browser withholds the reason for local WebSocket failures; a bad
      // token and a dead daemon look identical here, so say so rather than guess.
      this.emit('link', 'error', 'socket error — daemon unreachable or token rejected');
    };

    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      if (!this.stopped) {
        this.emit('link', 'closed');
        this.scheduleRetry();
      }
    };
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer !== null) return;
    const delay = Math.min(1000 * 2 ** this.retries, 15000);
    this.retries += 1;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.openSocket();
    }, delay);
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let msg: DaemonEvent;
    try {
      msg = JSON.parse(raw) as DaemonEvent;
    } catch {
      return;
    }

    switch (msg.type) {
      case 'EegBands':
        this.emit('bands', msg.payload as EegBands);
        break;
      case 'status':
      case 'StatusUpdate':
        this.emit('status', msg.payload as DaemonStatus);
        break;
      case 'SignalQuality':
        this.emit('quality', (msg.payload as SignalQuality).quality ?? []);
        break;
      case 'Battery':
        this.emit('battery', (msg.payload as BatteryPayload).level_pct);
        break;
      // EegSample / PpgSample / ImuSample arrive at the raw sample rate and are
      // deliberately ignored: this dashboard plots derived metrics, and parsing
      // 256 Hz of raw channel data would cost far more than it shows.
      default:
        break;
    }
  }

  /** One-shot HTTP status fetch, used at boot before the first event arrives. */
  async fetchStatus(): Promise<DaemonStatus | null> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/status`, {
        headers: { Authorization: `Bearer ${this.config.token}` },
      });
      if (!res.ok) return null;
      return (await res.json()) as DaemonStatus;
    } catch {
      return null;
    }
  }

  /** Ask the daemon to re-pair with the preferred headset. Requires admin scope. */
  async retryConnect(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/v1/control/retry-connect`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
