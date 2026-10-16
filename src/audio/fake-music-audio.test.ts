import { normalizePattern } from '../engine/metronome/pattern';
import { AnalysisStream, runOffline } from '../engine/pitch/stream';
import { FakeMusicAudio } from './fake-music-audio';
import { pcmFromBytes, type BeatEvent } from './music-audio';
import { TunerLoop } from './tuner-loop';

const sineAt = (hz: number, sr: number, seconds: number, lead = 0.2) => {
  const n = Math.round(seconds * sr);
  const x = new Float32Array(n);
  for (let i = Math.round(lead * sr); i < n; i++) x[i] = 0.3 * Math.sin((2 * Math.PI * hz * i) / sr);
  for (let i = 0; i < n; i++) x[i] += 1e-4 * Math.sin(i * 1.7); // not digital silence
  return x;
};

describe('Node fake of the native module + tuner loop', () => {
  it('delivers input at real-time pace; the loop reads the same states as the offline runner', async () => {
    const sr = 48000;
    const samples = sineAt(196, sr, 1.5);
    const audio = new FakeMusicAudio({ input: { samples, sampleRate: sr } });
    const info = await audio.startInput();
    expect(info.sampleRate).toBe(sr);
    const cfg = { a4: 440, targets: [40, 45, 50, 55, 59, 64], locked: null, tolerance: 3 };
    const loop = new TunerLoop(audio, sr, cfg);
    const live = [];
    for (let i = 0; i < 44; i++) {
      audio.advance(1000 / 30);
      const s = loop.frame();
      if (s) live.push(s);
    }
    const offline = runOffline(samples, sr, cfg, 1600);
    const last = live[live.length - 1];
    const ref = offline[live.length - 1];
    expect(last.hz).toBeCloseTo(ref.hz as number, 6);
    expect(last).toMatchObject({ noteMidi: 55, stringIndex: 3, status: 'inTune' });
    expect(loop.dropped).toBe(0);
  });

  it('reports dropped frames when JS reads later than the 2 s ring', async () => {
    const audio = new FakeMusicAudio({ input: { samples: new Float32Array(48000 * 10), sampleRate: 48000 } });
    await audio.startInput();
    audio.advance(3000);
    const r = audio.readInput(1 << 20);
    expect(pcmFromBytes(r.data).length).toBe(96000);
    expect(r.dropped).toBe(48000);
  });

  it('metronome onBeat carries the sample and presentation time (output latency added)', async () => {
    const audio = new FakeMusicAudio({ outputLatencyMs: 20 });
    const beats: BeatEvent[] = [];
    audio.addListener('onBeat', (e) => beats.push(e));
    await audio.metronomeStart(normalizePattern({ bpm: 120 }));
    audio.advance(2000);
    expect(beats.map((b) => [b.sample, b.presentationMs, b.kind])).toEqual([
      [0, 20, 'accent'],
      [24000, 520, 'beat'],
      [48000, 1020, 'beat'],
      [72000, 1520, 'beat'],
    ]);
    await audio.metronomeUpdate(normalizePattern({ bpm: 60 }), 'beat');
    audio.advance(2000);
    // The click at 96000 was already scheduled; the edit applies at the next beat (120000), then 60 BPM.
    expect(beats.slice(4).map((b) => b.sample)).toEqual([96000, 120000, 168000]);
    await audio.metronomeStop();
    expect(audio.metronomeState().playing).toBe(false);
  });
});

describe('analysis stream', () => {
  it('returns the newest samples oldest-first across the ring wrap, zero padded at the start', () => {
    const s = new AnalysisStream(48000, 8);
    s.push(new Float32Array([1, 1, 1]));
    const w = s.window(5);
    expect(w[0]).toBe(0);
    expect(w[1]).toBe(0);
    for (let i = 0; i < 20; i++) s.push(new Float32Array([i]));
    expect(s.total).toBe(23);
    expect(() => s.window(9)).toThrow();
  });

  it('the stream high-pass removes DC and passes a 100 Hz tone', () => {
    const sr = 48000;
    const s = new AnalysisStream(sr);
    const x = new Float32Array(sr);
    for (let i = 0; i < sr; i++) x[i] = 0.5 + 0.2 * Math.sin((2 * Math.PI * 100 * i) / sr);
    s.push(x);
    const w = s.window(4800);
    const mean = w.reduce((a, v) => a + v, 0) / w.length;
    const peak = Math.max(...Array.from(w));
    expect(Math.abs(mean)).toBeLessThan(0.002);
    expect(peak).toBeGreaterThan(0.19);
  });
});
