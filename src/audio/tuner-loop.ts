// The tuner's per-frame pull loop (SPEC §5.4 / D15): read the frames captured since the last UI frame and feed the
// engine, which analyses at its own fixed signal-time hop (30 per second, review S1) — a 120 Hz display does not make
// the tracker run 4× faster. Works against the native module or the Node fake alike.
import { TunerEngine } from '../engine/pitch/stream';
import type { TrackerConfig, TunerState } from '../engine/pitch/tracker';
import { pcmFromBytes, type MusicAudio } from './music-audio';

export class TunerLoop {
  readonly engine: TunerEngine;
  private audio: MusicAudio;
  dropped = 0;

  constructor(audio: MusicAudio, sampleRate: number, config: TrackerConfig) {
    this.audio = audio;
    this.engine = new TunerEngine(sampleRate, config);
  }

  /** One UI frame: returns the newest state to draw, or null when no analysis was due (keep drawing the last one). */
  frame(maxFrames = 16384): TunerState | null {
    const { data, dropped } = this.audio.readInput(maxFrames);
    this.dropped += dropped;
    if (data.byteLength === 0) return null;
    return this.engine.push(pcmFromBytes(data));
  }
}
