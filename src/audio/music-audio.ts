// Contract of the local native module `modules/music-audio` (SPEC §6). The P3 spike implements it in Swift/Kotlin;
// until then only `FakeMusicAudio` (src/audio/fake-music-audio.ts) implements it — in Jest and Node scripts.
// Nothing here imports React Native, so engine code and tests can depend on the types.
import type { MetronomeEvent } from '../engine/metronome/schedule';
import type { Pattern } from '../engine/metronome/pattern';

export type InputSource = 'unprocessed' | 'voiceRecognition' | 'mic' | 'builtInMic' | 'headsetMic' | 'file' | 'other';
export type Route = 'speaker' | 'wired' | 'bluetooth' | 'usb' | 'airplay' | 'other';

export type InputInfo = { sampleRate: number; source: InputSource; framesPerCallback: number };

export type InputRead = {
  /** Float32 little-endian mono PCM: the frames captured since the previous read (at most maxFrames, newest). */
  data: Uint8Array;
  /** Frames lost since the previous read (ring buffer overrun because JS read too late). */
  dropped: number;
};

export type BeatEvent = Pick<MetronomeEvent, 'bar' | 'beat' | 'pulse' | 'kind' | 'level' | 'sample'> & {
  /**
   * Wall-clock ms (performance.now() domain) when this click leaves the speaker. Native implementations MUST derive it
   * from a fresh hardware timestamp of the output (Android `AudioTrack.getTimestamp`, iOS `AVAudioTime` host time of
   * the render), re-anchored at least once per second — never `start + sample / sampleRate + latency` like the Node
   * fake: the audio clock and the wall clock drift apart by tens of ppm, ≈ 0.2 s per hour (review S10, A13).
   */
  presentationMs: number;
};

export type AudioInfo = {
  sampleRate: number;
  outputLatencyMs: number;
  inputLatencyMs: number;
  ioBufferMs: number;
  route: Route;
  underruns: number;
  inputSource: InputSource | null;
};

export type MetronomeState = { playing: boolean; sample: number; bar: number; beat: number; bpm: number };

export type MusicAudioEvents = {
  onBeat: (e: BeatEvent) => void;
  onInterruption: (e: { began: boolean }) => void;
  onRouteChange: (e: { route: Route }) => void;
  onAction: (e: { action: 'pause' | 'stop' | 'play' }) => void;
  onAutoStop: (e: { minutes: number }) => void;
  onError: (e: { message: string; recoverable: boolean }) => void;
};

export interface MusicAudio {
  startInput(opts: { sampleRate: number }): Promise<InputInfo>;
  stopInput(): Promise<void>;
  /** Synchronous: called once per UI frame by the tuner loop. */
  readInput(maxFrames: number): InputRead;

  metronomeStart(pattern: Pattern): Promise<void>;
  metronomeUpdate(pattern: Pattern, at: 'beat' | 'bar'): Promise<void>;
  metronomeStop(): Promise<void>;
  metronomeState(): MetronomeState;

  toneStart(opts: { hz: number; level?: number; sustain: boolean }): Promise<void>;
  toneStop(): Promise<void>;

  setHaptics(on: boolean): void;
  setBackground(opts: { autoStopMin: number; mix: boolean }): void;
  audioInfo(): AudioInfo;

  addListener<K extends keyof MusicAudioEvents>(event: K, listener: MusicAudioEvents[K]): { remove(): void };
}

/** Uint8Array (float32 LE) → Float32Array view without copying when aligned (it always is from native). */
export function pcmFromBytes(data: Uint8Array): Float32Array {
  if (data.byteOffset % 4 === 0) return new Float32Array(data.buffer, data.byteOffset, data.byteLength >> 2);
  return new Float32Array(data.slice().buffer);
}
