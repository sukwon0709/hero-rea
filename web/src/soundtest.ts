// Dev page: lists every song and sound effect of the game and plays them through the audio port.
import { getGameFiles } from './gamefiles';
import { SoundPlayer, type MusicFile } from './audio/player';
import { sfxNames, songTitles } from './audio/music';

const OTHER: Record<string, string[]> = {
  'OPMUSIC.R3': ['Opening (played once)', 'Opening / title (repeats)'],
  'EDMUSIC.R3': ['Ending 1 (played once)', 'Ending 2 (played once)', 'Ending 3 (repeats)'],
};

function row(table: HTMLTableElement, n: number, label: string, onPlay: () => void): HTMLTableRowElement {
  const tr = table.insertRow();
  tr.insertCell().textContent = String(n);
  tr.cells[0].className = 'n';
  tr.insertCell().textContent = label;
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = '▶';
  b.onclick = onPlay;
  tr.insertCell().append(b);
  return tr;
}

async function main() {
  const files = await getGameFiles(document.getElementById('picker')!);
  const root = document.getElementById('sound')!;
  root.hidden = false;
  const player = new SoundPlayer(files);
  const main = files.get('MAIN.EXE')!;
  const titles = songTitles(main);
  const status = document.getElementById('status')!;
  const gamelike = document.getElementById('gamelike') as HTMLInputElement;
  let playingRow: HTMLTableRowElement | null = null;
  const mark = (tr: HTMLTableRowElement | null, text: string) => {
    playingRow?.classList.remove('on');
    playingRow = tr;
    tr?.classList.add('on');
    status.textContent = text;
  };

  const play = (tr: HTMLTableRowElement, file: MusicFile, i: number, repeat: boolean, label: string) => {
    void player.start();
    if (gamelike.checked) player.changeSong(i, file, file === 'MUSIC.R3' ? 8 : 16);
    else player.playSong(i, file, repeat);
    mark(tr, `${file} #${i} ${label}`);
  };

  const music = document.getElementById('music') as HTMLTableElement;
  for (let i = 0; i < player.songCount('MUSIC.R3'); i++) {
    const tr = row(music, i, titles[i] ?? '', () => play(tr, 'MUSIC.R3', i, true, titles[i]));
  }
  const other = document.getElementById('other') as HTMLTableElement;
  for (const f of ['OPMUSIC.R3', 'EDMUSIC.R3'] as MusicFile[]) {
    for (let i = 0; i < player.songCount(f); i++) {
      const label = `${f} — ${OTHER[f][i] ?? ''}`;
      const repeat = i === player.songCount(f) - 1;
      const tr = row(other, i, label, () => play(tr, f, i, repeat, label));
    }
  }
  const sfx = document.getElementById('sfx') as HTMLTableElement;
  sfxNames(main).forEach((name, i) => {
    row(sfx, i, name, () => {
      void player.start();
      player.playSfx(i);
    });
  });

  document.getElementById('stop')!.onclick = () => {
    player.stop();
    player.stopSfx();
    mark(null, '');
  };
  document.getElementById('fade')!.onclick = () => {
    player.fadeOut(8);
    mark(null, 'fading out');
  };
  const vol = document.getElementById('vol') as HTMLInputElement;
  vol.oninput = () => (player.volume = Number(vol.value));
}

void main();
