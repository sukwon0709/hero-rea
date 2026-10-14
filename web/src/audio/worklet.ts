// AudioWorklet processor running the SBOPL2 driver port and the OPL2 emulator (see player.ts).
import { Synth, type SynthCommand } from './synth';

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;

class OplProcessor extends AudioWorkletProcessor {
  private readonly synth = new Synth(sampleRate);

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<SynthCommand>) => {
      this.synth.command(e.data);
      this.port.postMessage({ song: this.synth.driver.song, sfx: this.synth.driver.sfxNo });
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    if (out && out[0]) {
      this.synth.render(out[0], out[0].length);
      for (let c = 1; c < out.length; c++) out[c].set(out[0]);
    }
    return true;
  }
}

registerProcessor('hero-opl2', OplProcessor);
