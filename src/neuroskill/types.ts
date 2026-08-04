/**
 * Types for the NeuroSkill skill-daemon local API.
 *
 * Field names below were captured from a live Muse 2 session against
 * daemon 0.1.0 (protocol_version 1) rather than transcribed from the docs,
 * so they reflect what the socket actually emits.
 */

/** Envelope wrapping every server -> client WebSocket message. */
export interface DaemonEvent<T = unknown> {
  type: string;
  ts_unix_ms: number;
  correlation_id: string | null;
  payload: T;
}

/** Per-electrode band powers, one entry per channel (TP9, AF7, AF8, TP10). */
export interface ChannelBands {
  channel: string;
  delta: number;
  theta: number;
  alpha: number;
  beta: number;
  gamma: number;
  high_gamma: number;
  rel_delta: number;
  rel_theta: number;
  rel_alpha: number;
  rel_beta: number;
  rel_gamma: number;
  rel_high_gamma: number;
  dominant: string;
  dominant_symbol: string;
  dominant_color: string;
}

/**
 * `EegBands` payload — the main real-time metric frame.
 *
 * Documented at ~4 Hz; a Muse 2 on this daemon actually delivers ~8 Hz.
 * Every field is optional on the consuming side because the daemon omits
 * metrics it cannot compute (PPG-derived values are absent when the headset
 * reports no pulse signal, for instance).
 */
export interface EegBands {
  /** Seconds since the Unix epoch, fractional. */
  timestamp: number;

  channels: ChannelBands[];

  // --- Affective / valence ---
  /** 0-100. FAA rescaled via `50 + 50*tanh(FAA*k)`. 50 is neutral. */
  mood: number;
  /** Raw frontal alpha asymmetry: `ln(alpha_AF8) - ln(alpha_AF7)`, about -1.5..1.5. */
  faa: number;
  /** -1 (left-dominant) .. +1 (right-dominant) broadband power asymmetry. */
  laterality_index: number;

  // --- Brain-state scores, all 0-100 ---
  engagement: number;
  focus: number;
  relaxation: number;
  meditation: number;
  cognitive_load: number;
  drowsiness: number;

  // --- Aggregate relative band powers (all channels pooled) ---
  rel_delta: number;
  rel_theta: number;
  rel_alpha: number;
  rel_beta: number;
  rel_gamma: number;

  // --- Signal quality & spectral descriptors ---
  snr: number;
  apf: number;
  sef95: number;
  spectral_centroid: number;
  pse: number;
  coherence: number;

  // --- Ratios ---
  tar: number;
  bar: number;
  dtr: number;
  tbr: number;

  // --- Complexity ---
  higuchi_fd: number;
  permutation_entropy: number;
  sample_entropy: number;
  dfa_exponent: number;
  hjorth_activity: number;
  hjorth_mobility: number;
  hjorth_complexity: number;

  // --- Consciousness proxies, 0-100 ---
  consciousness_lzc: number;
  consciousness_wakefulness: number;
  consciousness_integration: number;

  // --- Artifacts / events ---
  blink_count: number;
  blink_rate: number;

  // Anything else the daemon adds later.
  [key: string]: unknown;
}

/** Per-channel electrode contact quality. */
export type QualityLevel = 'good' | 'medium' | 'bad' | string;

export interface SignalQuality {
  quality: QualityLevel[];
}

export interface BatteryPayload {
  level_pct: number;
}

/** `GET /v1/status` response, also broadcast as the `status` event. */
export interface DaemonStatus {
  state: 'connected' | 'connecting' | 'disconnected' | string;
  device_name: string | null;
  device_kind: string;
  device_id: string | null;
  sample_count: number;
  battery: number;
  device_error: string | null;
  target_display_name: string | null;
  channel_names: string[];
  channel_quality: QualityLevel[];
  eeg_sample_rate_hz: number;
  retry_attempt: number;
  retry_countdown_secs: number;
  [key: string]: unknown;
}

/** Connection state of *our* socket to the daemon (not of the headset). */
export type LinkState = 'idle' | 'connecting' | 'open' | 'closed' | 'error';
