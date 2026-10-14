// Browser sound output: the SBOPL2 port + OPL2 emulator in an AudioWorklet (ScriptProcessor
// fallback), with an API shaped after the game's own sound calls (see docs/SOUND.md).
import workletUrl from './worklet.ts?worker&url';
import { mainSfxBank, musicEntries, type Bank } from './music';
import { Synth, type SynthCommand } from './synth';

export type MusicFile = 'MUSIC.R3' | 'OPMUSIC.R3' | 'EDMUSIC.R3';

/** Game files the player reads (a subset of gamefiles.ts GameFiles). */
export type SoundFiles = Map<string, Uint8Array>;

export class SoundPlayer {
  private ctx: AudioContext | null = null;
  private send: ((c: SynthCommand) => void) | null = null;
  private readonly songs = new Map<MusicFile, Uint8Array[]>();
  private readonly sfx: Bank | null;
  private pending: SynthCommand[] = [];
  private starting: Promise<void> | null = null;
  private current: { file: MusicFile; index: number } | null = null;
  private vol = 1;

  constructor(files: SoundFiles) {
    for (const f of ['MUSIC.R3', 'OPMUSIC.R3', 'EDMUSIC.R3'] as MusicFile[]) {
      const d = files.get(f);
      if (d) this.songs.set(f, musicEntries(d));
    }
    const main = files.get('MAIN.EXE');
    this.sfx = main ? mainSfxBank(main) : null;
  }

  /** Number of songs in a music file (MUSIC.R3 has 20, OPMUSIC.R3 2, EDMUSIC.R3 3). */
  songCount(file: MusicFile = 'MUSIC.R3'): number {
    return this.songs.get(file)?.length ?? 0;
  }

  /** Creates/resumes the AudioContext. Call from a user gesture (browsers block autoplay). */
  start(): Promise<void> {
    if (this.ctx) return this.ctx.resume();
    if (!this.starting) this.starting = this.init();
    return this.starting;
  }

  private async init() {
    const ctx = new AudioContext();
    this.ctx = ctx;
    const gain = ctx.createGain();
    gain.gain.value = 1;
    gain.connect(ctx.destination);
    try {
      await ctx.audioWorklet.addModule(workletUrl);
      const node = new AudioWorkletNode(ctx, 'hero-opl2', { numberOfInputs: 0, outputChannelCount: [1] });
      node.connect(gain);
      this.send = (c) => node.port.postMessage(c);
    } catch {
      // no AudioWorklet (old browser / insecure context): run the synth on the main thread
      const synth = new Synth(ctx.sampleRate);
      const sp = ctx.createScriptProcessor(2048, 0, 1);
      sp.onaudioprocess = (e) => {
        const out = e.outputBuffer.getChannelData(0);
        synth.render(out, out.length);
      };
      sp.connect(gain);
      this.send = (c) => synth.command(c);
    }
    if (this.sfx) this.send({ type: 'sfxBank', data: this.sfx.data, offset: this.sfx.offset });
    this.send({ type: 'volume', value: 2 * this.vol });
    for (const c of this.pending) this.send(c);
    this.pending = [];
    await ctx.resume();
  }

  private cmd(c: SynthCommand) {
    if (this.send) this.send(c);
    else this.pending.push(c);
  }

  /**
   * Plays entry `index` of a music file (MAIN.EXE 0CF5:600A / 5F8E: entry = song number,
   * repeat on). OPMUSIC.R3 and EDMUSIC.R3 are used the same way by OPEN.EXE and END.EXE.
   */
  playSong(index: number, file: MusicFile = 'MUSIC.R3', repeat = true) {
    const bank = this.songs.get(file)?.[index];
    if (!bank) throw new Error(`${file} has no song ${index}`);
    this.current = { file, index };
    this.cmd({ type: 'play', song: 1, repeat, data: bank.slice() });
  }

  /**
   * Song change the way MAIN.EXE does it (0CF5:600A): nothing if that song is already playing,
   * otherwise fade the current song out (speed 8; OPEN/END use 16) and then start the new one.
   */
  changeSong(index: number, file: MusicFile = 'MUSIC.R3', fade = 8) {
    if (this.current && this.current.file === file && this.current.index === index) return;
    const bank = this.songs.get(file)?.[index];
    if (!bank) throw new Error(`${file} has no song ${index}`);
    this.current = { file, index };
    this.cmd({ type: 'play', song: 1, repeat: true, data: bank.slice(), fadeFirst: fade });
  }

  /** The song last started with playSong (it may have finished if repeat was off). */
  get song(): { file: MusicFile; index: number } | null {
    return this.current;
  }

  /** Stops the music at once (int 66h AH=02h AL=0). */
  stop() {
    this.current = null;
    this.cmd({ type: 'stop', fade: 0 });
  }

  /** Fades the music out (int 66h AH=02h; MAIN uses speed 8, or 16/4 in some scenes ≈ speed×65 ms). */
  fadeOut(speed = 8) {
    this.current = null;
    this.cmd({ type: 'stop', fade: speed });
  }

  /** Plays sound effect `n` as numbered by MAIN.EXE (0CF5:619A passes n+1 to int 66h AH=11h). */
  playSfx(n: number) {
    this.cmd({ type: 'sfx', n: n + 1 });
  }

  stopSfx() {
    this.cmd({ type: 'stopSfx' });
  }

  /** Master volume (1 = DOSBox-like level). */
  set volume(v: number) {
    this.vol = v;
    this.cmd({ type: 'volume', value: 2 * v });
  }

  get volume(): number {
    return this.vol;
  }

  async close() {
    await this.ctx?.close();
    this.ctx = null;
    this.send = null;
    this.starting = null;
  }
}
