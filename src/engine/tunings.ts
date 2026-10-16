// Instruments and tunings (SPEC §5.2). Data only: strings low → high AS PLAYED (across the neck, so re-entrant ukulele
// and the banjo's short 5th string come first), as MIDI numbers (C4 = 60, A4 = 69) — never names, so nothing is parsed.
//
// Source rule (V1_PLAN P1, D27): a tuning is listed only when two independent sources agree on its notes, or when it is
// a uniform shift (every string by the same interval) of such a tuning ("derived"). Checked 2026-10-16:
//   W   = Wikipedia "List of guitar tunings"            https://en.wikipedia.org/wiki/List_of_guitar_tunings
//   MU  = muted.io guitar tuning chart (octaves given)   https://muted.io/guitar-tuning-chart/
//   SS  = guitar.samesound.ru tunings reference          https://guitar.samesound.ru/en/reference/tunings
//   SJ  = Stringjoy "Alternate tunings" (octaves given)   https://stringjoy.com/alternate-tunings/
//   GCT = Guitar Composer's Toolbox tunings guide         https://guitarcomposerstoolbox.com/guitar-alternate-tunings-guide/
//   MR  = MusicRadar/Yahoo on Jimmy Page's C6 tuning      https://www.yahoo.com/lifestyle/articles/jimmy-page-used-open-c-092900040.html
//   GL  = guitarloot.org.uk "Renaissance lute tuning"     https://guitarloot.org.uk/page-47/page-59/
//   ST  = Strandberg 7/8-string tunings (via search)       https://strandbergguitars.com/en-BE/magazine/7-and-8-string-guitar-tunings-with-strandberg-
//   GGF = Guitar Gear Finder "How to tune a 7 string"     https://guitargearfinder.com/guides/tune-7-string-guitar/
//   W12 = Wikipedia "Twelve-string guitar"                https://en.wikipedia.org/wiki/Twelve-string_guitar
//   DA12= D'Addario "How to tune a 12-string"             https://www.daddario.com/en-ca/blogs/guitar/how-to-tune-a-12-string-guitar
//   WB  = Wikipedia "Bass guitar tuning"                  https://en.wikipedia.org/wiki/Bass_guitar_tuning
//   SB  = Soundbrenner bass tunings article               https://www.soundbrenner.com/blogs/articles/how-to-tune-your-bass-guitar-standard-5-string-and-drop-tunings
//   GTI = guitartuner.io bass tuning frequencies          https://guitartuner.io/resources/bass-guitar-tuning
//   TB  = TalkBass 5-string thread (BEADG)                https://www.talkbass.com/threads/5-string-tuning-eadgc-vc-beadg.502292/
//   TH  = Thomann "Tuning the ukulele"                    https://www.thomann.co.uk/onlineexpert_page_tuning_the_ukulele_quick_guide.html
//   KA  = Kala "Ukulele tuning decoded"                   https://kalabrand.com/blogs/home/ukulele-tuning-decoded
//   HP  = HyperPhysics violin/cello pages                 https://hyperphysics.gsu.edu/hbase/Music/violin.html
//   WV  = Wikipedia instrument pages (violin, viola, cello, double bass, mandolin, mandola, octave mandolin)
//   SBO = stringbassonline.com "Bass tuning"              https://www.stringbassonline.com/tuning.htm
//   MLU = mandolinluthier.com "Mandola tuning"            https://mandolinluthier.com/tuning_mandola.html
//   DB  = Deering Banjos "How to tune a banjo"            https://www.deeringbanjos.com/pages/how-to-tune-a-banjo
//   CDR = creekdontrise.com five-string banjo tunings     https://creekdontrise.com/acoustic/irish_banjo/instruments/five-string-banjo/tunings.html
// Dropped for lack of two agreeing sources (L11 row): Open F (W only), Major thirds (W and SJ disagree on the pitch
// level), DADADD (no source), 5-string bass Drop A (forum only). Duplicates folded into aliases: CGCGCE = Open C,
// Hawaiian Taro Patch = Open G (GCT says so).

export type InstrumentId =
  | 'chromatic'
  | 'guitar'
  | 'guitar7'
  | 'guitar8'
  | 'guitar12'
  | 'baritone'
  | 'bass4'
  | 'bass5'
  | 'bass6'
  | 'ukulele'
  | 'ukuleleBaritone'
  | 'violin'
  | 'viola'
  | 'cello'
  | 'doubleBass'
  | 'mandolin'
  | 'mandola'
  | 'octaveMandolin'
  | 'banjo5'
  | 'banjoTenor';

export type Instrument = {
  id: InstrumentId;
  /** i18n key, `instrument.<id>`. */
  nameKey: string;
  /** Capo applies (SPEC §7.2: capo stepper only for fretted instruments). */
  fretted: boolean;
};

export type Tuning = {
  /** Stable id `<instrument>.<slug>`; stored in settings and backups — never rename. */
  id: string;
  instrument: InstrumentId;
  /** i18n key, `tuning.<id>`. */
  nameKey: string;
  /** MIDI notes, low → high as played. For coursed instruments: the main (lower) member of each course. */
  strings: readonly number[];
  /** Show flats (E♭ standard) instead of sharps. */
  flats?: boolean;
  /** One entry per string: every member of the course (octave members differ from `strings[i]`). */
  courses?: readonly (readonly number[])[];
  /** Extra search terms (other names of the same notes). */
  aliases?: readonly string[];
};

export const INSTRUMENTS: readonly Instrument[] = [
  { id: 'chromatic', nameKey: 'instrument.chromatic', fretted: false },
  { id: 'guitar', nameKey: 'instrument.guitar', fretted: true },
  { id: 'guitar7', nameKey: 'instrument.guitar7', fretted: true },
  { id: 'guitar8', nameKey: 'instrument.guitar8', fretted: true },
  { id: 'guitar12', nameKey: 'instrument.guitar12', fretted: true },
  { id: 'baritone', nameKey: 'instrument.baritone', fretted: true },
  { id: 'bass4', nameKey: 'instrument.bass4', fretted: true },
  { id: 'bass5', nameKey: 'instrument.bass5', fretted: true },
  { id: 'bass6', nameKey: 'instrument.bass6', fretted: true },
  { id: 'ukulele', nameKey: 'instrument.ukulele', fretted: true },
  { id: 'ukuleleBaritone', nameKey: 'instrument.ukuleleBaritone', fretted: true },
  { id: 'violin', nameKey: 'instrument.violin', fretted: false },
  { id: 'viola', nameKey: 'instrument.viola', fretted: false },
  { id: 'cello', nameKey: 'instrument.cello', fretted: false },
  { id: 'doubleBass', nameKey: 'instrument.doubleBass', fretted: false },
  { id: 'mandolin', nameKey: 'instrument.mandolin', fretted: true },
  { id: 'mandola', nameKey: 'instrument.mandola', fretted: true },
  { id: 'octaveMandolin', nameKey: 'instrument.octaveMandolin', fretted: true },
  { id: 'banjo5', nameKey: 'instrument.banjo5', fretted: true },
  { id: 'banjoTenor', nameKey: 'instrument.banjoTenor', fretted: true },
];

const t = (
  instrument: InstrumentId,
  slug: string,
  strings: number[],
  extra: Omit<Tuning, 'id' | 'instrument' | 'nameKey' | 'strings'> = {}
): Tuning => ({ id: `${instrument}.${slug}`, instrument, nameKey: `tuning.${instrument}.${slug}`, strings, ...extra });

const pairs = (strings: number[], octave: boolean[]): number[][] => strings.map((m, i) => [m, octave[i] ? m + 12 : m]);
const unison = (strings: number[]): number[][] => strings.map((m) => [m, m]);

export const TUNINGS: readonly Tuning[] = [
  t('chromatic', 'chromatic', []),

  // ---- Guitar, 6 strings ----
  t('guitar', 'standard', [40, 45, 50, 55, 59, 64]), // E2 A2 D3 G3 B3 E4 — W, MU, SS
  t('guitar', 'half-step-down', [39, 44, 49, 54, 58, 63], { flats: true, aliases: ['Eb standard', 'E flat'] }), // E♭ — W, MU, SS
  t('guitar', 'whole-step-down', [38, 43, 48, 53, 57, 62], { aliases: ['D standard'] }), // D G C F A D — W, MU, SS, SJ
  t('guitar', 'drop-d', [38, 45, 50, 55, 59, 64]), // D A D G B E — W, MU, SS, SJ
  t('guitar', 'drop-c-sharp', [37, 44, 49, 54, 58, 63], { aliases: ['Drop Db'] }), // C♯ G♯ C♯ F♯ A♯ D♯ — W, SS, SJ
  t('guitar', 'drop-c', [36, 43, 48, 53, 57, 62]), // C G C F A D — W, MU, SS, SJ
  t('guitar', 'drop-b', [35, 42, 47, 52, 56, 61]), // B F♯ B E G♯ C♯ — W, MU, SS, SJ
  t('guitar', 'drop-a-sharp', [34, 41, 46, 51, 55, 60], { aliases: ['Drop Bb'] }), // A♯1 F2 A♯2 D♯3 G3 C4 — SJ; derived: Drop B − 1
  t('guitar', 'drop-a', [33, 40, 45, 50, 54, 59]), // A1 E2 A2 D3 F♯3 B3 — W, MU, SS, SJ
  t('guitar', 'drop-g', [31, 38, 43, 48, 52, 57]), // G1 D2 G2 C3 E3 A3 — W; derived: Drop A − 2
  t('guitar', 'double-drop-d', [38, 45, 50, 55, 59, 62]), // D A D G B D — W, MU, SS, SJ
  t('guitar', 'dadgad', [38, 45, 50, 55, 57, 62], { aliases: ['Dsus4', 'Open Dsus4'] }), // W, MU, SS
  t('guitar', 'open-d', [38, 45, 50, 54, 57, 62], { aliases: ['Vestapol'] }), // D A D F♯ A D — W, MU, SS, SJ
  t('guitar', 'open-d-minor', [38, 45, 50, 53, 57, 62]), // D A D F A D — W (cross-note D), SJ
  t('guitar', 'open-e', [40, 47, 52, 56, 59, 64]), // E B E G♯ B E — W, MU, SS, SJ
  t('guitar', 'open-g', [38, 43, 50, 55, 59, 62], { aliases: ['Taro patch', 'Slack key', 'Spanish'] }), // D G D G B D — W, MU, SS, GCT
  t('guitar', 'open-g-minor', [38, 43, 50, 55, 58, 62], { flats: true }), // D G D G B♭ D — W (cross-note G), SJ
  t('guitar', 'open-a', [40, 45, 49, 52, 57, 64]), // E A C♯ E A E — W, MU, SJ
  t('guitar', 'open-a-minor', [40, 45, 52, 57, 60, 64]), // E A E A C E — W (cross-note A), SJ
  t('guitar', 'open-c', [36, 43, 48, 55, 60, 64], { aliases: ['CGCGCE'] }), // C G C G C E — W, MU, SS, SJ
  t('guitar', 'open-c-minor', [36, 43, 48, 55, 60, 63], { flats: true }), // C G C G C E♭ — W (cross-note C), SJ
  t('guitar', 'open-b', [35, 42, 47, 54, 59, 63]), // B F♯ B F♯ B D♯ — W, MU
  t('guitar', 'c6', [36, 45, 48, 55, 60, 64]), // C A C G C E — W, MR
  t('guitar', 'g-modal', [38, 43, 50, 55, 60, 62], { aliases: ['DGDGCD', 'Gsus4'] }), // D G D G C D — W, SJ ("Modal G")
  t('guitar', 'b-standard', [35, 40, 45, 50, 54, 59]), // B E A D F♯ B — SS, SJ, GCT
  t('guitar', 'c-standard', [36, 41, 46, 51, 55, 60], { flats: true }), // C F B♭ E♭ G C — SS, SJ ("C tuning")
  t('guitar', 'c-sharp-standard', [37, 42, 47, 52, 56, 61]), // C♯ F♯ B E G♯ C♯ — SS, SJ
  t('guitar', 'a-standard', [33, 38, 43, 48, 52, 57]), // A1 D2 G2 C3 E3 A3 — SJ; derived: standard − 7
  t('guitar', 'lute', [40, 45, 50, 54, 59, 64], { aliases: ['Renaissance', 'Vihuela'] }), // E A D F♯ B E — W, GL
  t('guitar', 'new-standard', [36, 43, 50, 57, 64, 67], { aliases: ['NST', 'Fripp'] }), // C2 G2 D3 A3 E4 G4 — W, SS, SJ, GCT
  t('guitar', 'all-fourths', [40, 45, 50, 55, 60, 65]), // E2 A2 D3 G3 C4 F4 — W, SS, SJ
  t('guitar', 'nashville', [52, 57, 62, 67, 59, 64], { aliases: ['High-strung'] }), // E3 A3 D4 G4 B3 E4 — SJ, GCT

  // ---- Extended-range and other guitars ----
  t('guitar7', 'b-standard', [35, 40, 45, 50, 55, 59, 64]), // B1 E2 A2 D3 G3 B3 E4 — W, GCT, GGF
  t('guitar7', 'drop-a', [33, 40, 45, 50, 55, 59, 64]), // A E A D G B E — W, GGF
  t('guitar7', 'a-standard', [33, 38, 43, 48, 53, 57, 62]), // A1 D2 G2 C3 F3 A3 D4 — W; derived: B standard − 2
  t('guitar8', 'f-sharp-standard', [30, 35, 40, 45, 50, 55, 59, 64]), // F♯1 B1 E2 A2 D3 G3 B3 E4 — W, GCT, ST
  t('guitar8', 'drop-e', [28, 35, 40, 45, 50, 55, 59, 64]), // E1 B1 E2 … — W, ST
  t('guitar12', 'standard', [40, 45, 50, 55, 59, 64], {
    courses: pairs([40, 45, 50, 55, 59, 64], [true, true, true, true, false, false]), // E2E3 A2A3 D3D4 G3G4 B3B3 E4E4 — W12, DA12
  }),
  t('guitar12', 'drop-d', [38, 45, 50, 55, 59, 64], {
    courses: pairs([38, 45, 50, 55, 59, 64], [true, true, true, true, false, false]), // Drop D (W, MU) on 12-string courses
  }),
  t('baritone', 'b-standard', [35, 40, 45, 50, 54, 59]), // B1 E2 A2 D3 F♯3 B3 — GCT ("Baritone (B standard)"), SS
  t('baritone', 'a-standard', [33, 38, 43, 48, 52, 57]), // A1 D2 G2 C3 E3 A3 — SJ; derived: B standard − 2

  // ---- Bass ----
  t('bass4', 'standard', [28, 33, 38, 43]), // E1 A1 D2 G2 — WB, GTI, SB
  t('bass4', 'drop-d', [26, 33, 38, 43]), // D A D G — WB, SB, GTI
  t('bass4', 'half-step-down', [27, 32, 37, 42], { flats: true }), // E♭ A♭ D♭ G♭ — GTI; derived: standard − 1
  t('bass4', 'whole-step-down', [26, 31, 36, 41]), // D G C F — SB; derived: standard − 2
  t('bass4', 'drop-c', [24, 31, 36, 41]), // C1 G1 C2 F2 — WB, SB, GTI
  t('bass4', 'bead', [23, 28, 33, 38]), // B0 E1 A1 D2 — WB, TB
  t('bass5', 'standard', [23, 28, 33, 38, 43]), // B0 E1 A1 D2 G2 — WB, SB, GTI, TB
  t('bass6', 'standard', [23, 28, 33, 38, 43, 48]), // B0 E1 A1 D2 G2 C3 — WB, GTI

  // ---- Ukulele ----
  t('ukulele', 'standard', [67, 60, 64, 69], { aliases: ['GCEA', 'High G', 'Soprano', 'Concert', 'Tenor'] }), // G4 C4 E4 A4 — TH, KA
  t('ukulele', 'low-g', [55, 60, 64, 69]), // G3 C4 E4 A4 — TH, KA
  t('ukulele', 'd-tuning', [69, 62, 66, 71], { aliases: ['ADF#B'] }), // A4 D4 F♯4 B4 — TH, KA
  t('ukuleleBaritone', 'standard', [50, 55, 59, 64], { aliases: ['DGBE'] }), // D3 G3 B3 E4 — TH, KA

  // ---- Orchestral strings ----
  t('violin', 'standard', [55, 62, 69, 76]), // G3 D4 A4 E5 — WV, HP
  t('viola', 'standard', [48, 55, 62, 69]), // C3 G3 D4 A4 — WV, HP (viola table)
  t('cello', 'standard', [36, 43, 50, 57]), // C2 G2 D3 A3 — WV, HP
  t('doubleBass', 'standard', [28, 33, 38, 43]), // E1 A1 D2 G2 (sounding) — WV, SBO
  t('doubleBass', 'solo', [30, 35, 40, 45]), // F♯1 B1 E2 A2 — SBO, TalkBass; derived: standard + 2

  // ---- Mandolin family (unison courses) ----
  t('mandolin', 'standard', [55, 62, 69, 76], { courses: unison([55, 62, 69, 76]) }), // G3 D4 A4 E5 — WV, MLU
  t('mandola', 'standard', [48, 55, 62, 69], { courses: unison([48, 55, 62, 69]) }), // C3 G3 D4 A4 — WV, MLU
  t('octaveMandolin', 'standard', [43, 50, 57, 64], { courses: unison([43, 50, 57, 64]) }), // G2 D3 A3 E4 — WV, MLU

  // ---- Banjo (5th string = short drone, listed first as played) ----
  t('banjo5', 'open-g', [67, 50, 55, 59, 62], { aliases: ['gDGBD'] }), // g4 D3 G3 B3 D4 — DB, CDR
  t('banjo5', 'double-c', [67, 48, 55, 60, 62], { aliases: ['gCGCD'] }), // g4 C3 G3 C4 D4 — DB, CDR
  t('banjo5', 'open-d', [66, 50, 54, 57, 62], { aliases: ['f#DF#AD'] }), // f♯4 D3 F♯3 A3 D4 — DB, CDR
  t('banjoTenor', 'standard', [48, 55, 62, 69], { aliases: ['CGDA'] }), // C3 G3 D4 A4 — DB, CDR
  t('banjoTenor', 'irish', [43, 50, 57, 64], { aliases: ['GDAE'] }), // G2 D3 A3 E4 — DB, CDR
];

export const DEFAULT_TUNING_ID = 'guitar.standard';

const byId = new Map(TUNINGS.map((x) => [x.id, x]));

export function tuningById(id: string): Tuning | undefined {
  return byId.get(id);
}

export function instrumentById(id: InstrumentId): Instrument {
  return INSTRUMENTS.find((i) => i.id === id) as Instrument;
}

export function tuningsFor(instrument: InstrumentId): Tuning[] {
  return TUNINGS.filter((x) => x.instrument === instrument);
}

export const NOTE_MIN = 12; // C0
export const NOTE_MAX = 108; // C8
export const STRINGS_MAX = 12;

/**
 * Every note the tuner may target for a tuning: each course member (octave members included), deduplicated, low →
 * high in pitch. Capo already applied by the caller.
 */
export function targetNotes(tuning: Pick<Tuning, 'strings' | 'courses'>): number[] {
  const all = tuning.courses ? tuning.courses.flat() : [...tuning.strings];
  return [...new Set(all)].sort((a, b) => a - b);
}

/** Lowest and highest target of a tuning (null for chromatic). */
export function tuningRange(tuning: Pick<Tuning, 'strings' | 'courses'>): { low: number; high: number } | null {
  const notes = targetNotes(tuning);
  return notes.length ? { low: notes[0], high: notes[notes.length - 1] } : null;
}
