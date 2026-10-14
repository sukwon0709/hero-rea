import { describe, expect, it } from 'vitest';
import { parseChapter, type Chapter, type Message, type TalkLine } from '../src/formats/scenario';
import { ScriptVM, readEventSave, writeEventSave, getFlag, type ScriptHost, type Trigger } from '../src/engine/script';
import { gameFile, hasGame } from './gamedir';

/** A host that logs what the original would show and answers prompts from a script. */
class RecordingHost implements ScriptHost {
  log: string[] = [];
  answers: boolean[] = [];
  choices: number[] = [];
  private say(s: string) {
    this.log.push(s);
  }
  async talk(l: TalkLine) {
    this.say(`talk ${l.speaker}: ${l.text}`);
  }
  async ask(l: TalkLine) {
    const a = this.answers.shift() ?? true;
    this.say(`ask ${l.speaker}: ${l.text} -> ${a ? 'yes' : 'no'}`);
    return a;
  }
  async narrate(m: Message, c: { inPicture: boolean }) {
    this.say(`narrate${c.inPicture ? ' (picture)' : ''}: ${m.text}`);
  }
  async caption(m: Message) {
    this.say(`caption: ${m.text}`);
  }
  async title(m: Message) {
    this.say(`title: ${m.text}`);
  }
  async stageTitle(i: number) {
    this.say(`stage title ${i}`);
  }
  async choose(o: Message[]) {
    const i = this.choices.shift() ?? 0;
    this.say(`choose [${o.map((x) => x.text).join(' | ')}] -> ${i}`);
    return i;
  }
  async showPicture(p: number, mode: number) {
    this.say(`picture ${p} mode ${mode}`);
  }
  async closePicture() {
    this.say('close picture');
  }
  async setMap(map: number) {
    this.say(`map 0x${map.toString(16)}`);
  }
  async showMap() {}
  placeCharacter() {}
  moveCharacter() {}
  async waitMoves() {}
  removeCharacter() {}
  async addItem(i: number) {
    this.say(`item ${i}`);
  }
  addGold(n: number) {
    this.say(`gold +${n}`);
  }
  async savePrompt() {
    this.say('save prompt');
  }
  async battleEnd(map: number) {
    this.say(`battle end -> 0x${map.toString(16)}`);
  }
  async duel(a: number, b: number) {
    this.say(`duel ${a} vs ${b}`);
  }
  stageChanged(c: number, s: number) {
    this.say(`stage ${c}.${s}`);
  }
}

describe.skipIf(!hasGame)('script VM', () => {
  const cache = new Map<number, Chapter>();
  const load = (c: number) => {
    if (!cache.has(c)) cache.set(c, parseChapter(c, gameFile(`SNR${c}D.R3`), gameFile(`SNR${c}M.R3`)));
    return cache.get(c)!;
  };

  it('plays the prologue (SNR0) headlessly', async () => {
    const host = new RecordingHost();
    const vm = new ScriptVM(load, host);
    const step = async (t: Trigger) => {
      const r = await vm.dispatch(t);
      expect(r).not.toBe('none');
      await vm.runAuto();
    };

    await vm.runAuto();
    // Opening: title card, chapter title, picture + narration, then the Luoyang palace scene.
    expect(host.log.slice(0, 9)).toEqual([
      'stage title 0',
      'title: 서장 동탁타도군 일어나다.',
      'picture 3 mode 0',
      'narrate (picture): 때는 후한말. 후한의 세상은 반란과 폭동이 끊이지 않았다. 한왕조의 힘이 약해져 있다는 사실은 누가 보아도 분명했다. 이 혼란한 세상을 이은 사람이 바로 동탁이었다.',
      'narrate (picture): 동탁은 조정을 수중에 넣은 뒤, 황제를 무시한채, 자기마음대로 정치를 시작했다.\r\n처음에는 동탁을 미워하던 자들도, 그 무력 앞에 굴복하여, 동탁에게 아부하게 되었다. 황제의 권위는 더 이상 어디에서도 찾아볼 수 없었다.',
      'close picture',
      'map 0x2000',
      'caption: 낙양 궁전',
      'talk 3: 폐하, 염려하지 마십시요. 정치는 제가 알아서 하겠습니다.',
    ]);
    // Auto events run up to the allied camp, where the player has control (resident talk group).
    expect(vm.state.block).toBe(4);
    expect(host.log.at(-1)).toMatch(/^talk 12: 그리고, 출전하기 전에/);
    expect(vm.state.objective.subarray(0, 4)).toEqual(new Uint8Array([0xbb, 0xe7, 0xbc, 0xf6])); // "사수관..."

    // Talk to Gongsun Zan (#12) and Tao Qian (#15): they join the coming battle (flags 0 and 1).
    await step({ type: 'talk', officer: 12 });
    await step({ type: 'talk', officer: 15 });
    expect(getFlag(vm.state, 0) && getFlag(vm.state, 1)).toBe(true);
    // Talk to Guan Yu (#1) and agree to march: the battle of Sishui Gate is set up.
    host.answers.push(true);
    await step({ type: 'talk', officer: 1 });
    expect(host.log).toContain('save prompt');
    expect(vm.state.block).toBe(5);
    expect(vm.state.map).toBe(0x3000);
    // The four player units plus the two who joined.
    expect(vm.state.units.filter((u) => u.officer !== 0xffff && !(u.flags & 1)).map((u) => u.officer)).toEqual([0, 1, 2, 12, 15]);
    expect(vm.state.units.filter((u) => u.officer !== 0xffff && u.flags & 1).map((u) => u.officer)).toEqual([5, 20, 21, 27, 256, 257, 258]);
    expect(vm.state.victory).toEqual({ enabled: true, officer: 5 });

    // A treasure tile, then Hua Xiong (#5, the victory target) is defeated.
    await step({ type: 'unitAt', officer: 0x400, x: 7, y: 6 });
    expect(host.log.slice(-2)).toEqual(['gold +100', 'caption: 금 100을 손에 넣었다!']);
    await vm.dispatch({ type: 'unitAt', officer: 0x400, x: 7, y: 6 }); // already taken: IF skips
    expect(host.log.at(-1)).toBe('caption: 금 100을 손에 넣었다!');
    await step({ type: 'targetDefeated' });
    expect(host.log).toContain('narrate: 유비군은 화웅군을 무찌르고 사수관을 점령했다.');
    expect(host.log).toContain('battle end -> 0x1000');

    // Hulao Gate: the second battle (block 7) ends when Lu Bu (#4) retreats.
    expect(vm.state.block).toBe(7);
    expect(vm.state.map).toBe(0x3001);
    await step({ type: 'targetDefeated' });
    expect(host.log).toContain('narrate: 여포군은 퇴각했다. 유비군은 호로관을 점령했다.');
    // Remaining story scenes run by themselves and the chapter ends.
    const end = host.log.indexOf('stage 1.0');
    expect(host.log.slice(end - 2, end)).toEqual([
      'narrate: 이렇게, 반동탁연합군은 해산했다. 전 대륙은 동탁의 출현으로 멸망의 길을 걷기 시작하고 있었다. 이 난세에 천하를 노리는 자는 비단 동탁만이 아니었다. 조조가, 그리고 원소가.....',
      'narrate: 이 어지러운 세상을 유비 등은 어떻게 대처해 나갈까? 그리고 유비형제의 꿈인 한조재흥은 과연 이루어질 것인지.....',
    ]);
    // ...and auto events carry straight on into chapter 1.
    expect(vm.state.chapter).toBe(1);
    expect(host.log[end + 1]).toBe('stage title 1');
    expect(host.log.slice(0, end).filter((l) => l.startsWith('talk')).length).toBeGreaterThan(60);
  });

  it('round-trips the event saves', () => {
    for (let i = 0; i < 5; i++) {
      const b = gameFile(`ESAVE${i}.R3S`);
      expect(writeEventSave(readEventSave(b))).toEqual(b);
    }
    const s = readEventSave(gameFile('ESAVE0.R3S'));
    expect([s.chapter, s.stage, s.block, s.group]).toEqual([0, 0, 4, 2]);
  });

  it('resumes a saved game at the saved command', async () => {
    // ESAVE4: chapter 3 stage 4, saved by "SAVE_PROMPT 1" (status 1 = resume at pc).
    const host = new RecordingHost();
    const vm = new ScriptVM(load, host, readEventSave(gameFile('ESAVE4.R3S')));
    expect([vm.state.chapter, vm.state.stage, vm.state.status, vm.state.pc]).toEqual([3, 4, 1, 0x751]);
    await vm.dispatch({ type: 'auto' });
    expect(host.log[0]).toBe('talk 174: 주공, 부대를 편성해 주십시오.');
    expect(vm.state.victory).toEqual({ enabled: true, officer: 41 });
  });
});
