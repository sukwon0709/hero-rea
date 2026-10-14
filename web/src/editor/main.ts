// Save editor page (editor.html): pick a save from the shared browser store or a file, choose an officer
// and change level, experience, class (병종), troops, items, faction, and the party's money. The save is
// written back in its original byte format (model.ts / formats/save.ts).

import { getGameFiles, type GameFiles } from '../gamefiles';
import { MSAVE_OFF, msaveName, esaveName } from '../formats/save';
import { FACEDAT_COUNT, OFFICER_DYN_SIZE, parseBakData, parseBlobIndex, readEngineTables } from '../formats/tables';
import { decodeTfdce } from '../formats/tfdce';
import { PAL, paletteToRgba, readMainPalettes } from '../formats/palette';
import {
  EMPTY_ITEM,
  HERO,
  ITEM_SLOTS,
  MAX_EXP,
  MAX_LEVEL,
  MAX_MONEY,
  SaveEdit,
  classOptions,
  isPlaceholderName,
  itemLabel,
  type GameData,
} from './model';
import { download, listSlots, readUpload, slotZip, writeSlot, type Upload } from './store';

type Source = { kind: 'slot'; slot: number } | { kind: 'upload'; upload: Upload };

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

let files: GameFiles;
let data: GameData;
let faceBlobs: Uint8Array[] = [];
let faceRgba: Uint32Array;
const faceCache = new Map<number, ImageData | null>();

let edit: SaveEdit | null = null;
let source: Source | null = null;
let selected = HERO;

// ------------------------------------------------------------------ portraits (FACEDAT.R3, TF-DCE)

function faceImage(n: number): ImageData | null {
  if (faceCache.has(n)) return faceCache.get(n)!;
  let img: ImageData | null = null;
  try {
    const blob = faceBlobs[n];
    if (blob && blob.length) {
      const t = decodeTfdce(blob);
      img = new ImageData(t.width, t.height);
      const out = new Uint32Array(img.data.buffer);
      for (let i = 0; i < t.pixels.length; i++) out[i] = faceRgba[t.pixels[i] & 15];
    }
  } catch {
    img = null;
  }
  faceCache.set(n, img);
  return img;
}

function drawFace(c: HTMLCanvasElement, n: number) {
  const img = faceImage(n);
  if (!img) return;
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d')!.putImageData(img, 0, 0);
}

const faceObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const c = e.target as HTMLCanvasElement;
    faceObserver.unobserve(c);
    drawFace(c, +c.dataset.face!);
  }
});

// ------------------------------------------------------------------ names

const className = (c: number) => data.tables.classNames[c] ?? `#${c}`;
const factionName = (f: number) => data.tables.factionNames[f] ?? `#${f}`;
const itemName = (id: number) => itemLabel(data.bak.items[id], id);

// ------------------------------------------------------------------ slots / loading

function renderSlots() {
  const box = $('slots');
  box.replaceChildren();
  for (const s of listSlots(files)) {
    const b = el('button', { type: 'button', className: 'slot', disabled: s.empty }, el('b', {}, `슬롯 ${s.slot + 1} ${s.empty ? '(비어 있음)' : s.title}`), el('span', {}, s.empty ? msaveName(s.slot) : `${s.time} · ${msaveName(s.slot)}`));
    if (source?.kind === 'slot' && source.slot === s.slot) b.classList.add('active');
    b.onclick = () => {
      if (!confirmDiscard()) return;
      const m = files.get(msaveName(s.slot))!;
      open(m, { kind: 'slot', slot: s.slot });
    };
    box.append(b);
  }
}

function confirmDiscard(): boolean {
  return !edit || !edit.changed() || confirm('저장하지 않은 변경이 있습니다. 버리고 다른 세이브를 열까요?\nDiscard unsaved changes?');
}

function open(bytes: Uint8Array, src: Source, keepSelection = false) {
  $('loadError').textContent = '';
  try {
    edit = new SaveEdit(data, bytes.slice());
  } catch (e) {
    $('loadError').textContent = (e as Error).message;
    return;
  }
  source = src;
  if (!keepSelection) selected = HERO;
  $('editor').hidden = false;
  renderSlots();
  renderSaveBar();
  renderList();
  renderDetail();
}

function sourceLabel(): string {
  if (!source) return '';
  return source.kind === 'slot' ? `브라우저 슬롯 ${source.slot + 1} (${msaveName(source.slot)})` : `파일 ${source.upload.name}${source.upload.esave ? ' + ESAVE' : ''}`;
}

function renderSaveBar() {
  if (!edit || !source) return;
  $('saveTitle').textContent = edit.title() || '(제목 없음)';
  $('saveMeta').textContent = `${edit.time()} · ${sourceLabel()}`;
  const money = $<HTMLInputElement>('money');
  money.value = String(edit.money);
  const target = $<HTMLSelectElement>('targetSlot');
  if (source.kind === 'upload') {
    target.hidden = false;
    target.replaceChildren(
      ...listSlots(files).map((s) => el('option', { value: String(s.slot), textContent: `→ 슬롯 ${s.slot + 1}${s.empty ? ' (비어 있음)' : ` ${s.title}`}` })),
    );
    target.value = String(source.upload.slot ?? 0);
  } else target.hidden = true;
  $<HTMLButtonElement>('downloadZip').disabled = source.kind === 'upload' ? !source.upload.esave : !files.get(esaveName(source.slot));
  updateDirty();
}

function updateDirty() {
  const changed = !!edit && edit.changed();
  $('dirty').hidden = !changed;
  $<HTMLButtonElement>('revert').disabled = !changed;
}

function message(text: string, warn = false) {
  const m = $('saveMsg');
  m.textContent = text;
  m.classList.toggle('warn', warn);
}

// ------------------------------------------------------------------ officer list

function officerVisible(i: number, q: string): boolean {
  const name = data.bak.officers[i].name;
  if (isPlaceholderName(name)) return false;
  return !q || name.includes(q) || data.bak.officers[i].reading.toLowerCase().includes(q.toLowerCase());
}

function edited(i: number, now = edit?.bytes()): boolean {
  if (!edit || !now) return false;
  const off = MSAVE_OFF.officers + i * OFFICER_DYN_SIZE;
  for (let k = 0; k < OFFICER_DYN_SIZE; k++) if (now[off + k] !== edit.original[off + k]) return true;
  return false;
}

function renderList() {
  if (!edit) return;
  const ul = $('officers');
  ul.replaceChildren();
  const q = $<HTMLInputElement>('search').value.trim();
  const all = $<HTMLInputElement>('showAll').checked || q !== '';
  const roster = edit.roster();
  const inRoster = new Set(roster);
  const now = edit.bytes();
  const add = (i: number) => {
    const { st, dyn } = edit!.officer(i);
    const c = el('canvas', { className: 'face', width: 64, height: 80 });
    c.dataset.face = String(st.face);
    faceObserver.observe(c);
    const b = el(
      'button',
      { type: 'button', className: 'row' },
      c,
      el('span', { className: 'nm' }, st.name, el('span', { className: 'sub' }, `${className(dyn.cls)}${inRoster.has(i) ? '' : ` · ${factionName(dyn.flags & 0x1f)}`}`)),
      el('span', { className: 'lv' }, `Lv${dyn.level}`),
    );
    b.dataset.officer = String(i);
    if (i === selected) b.classList.add('sel');
    if (edited(i, now)) b.classList.add('edited');
    b.onclick = () => {
      selected = i;
      ul.querySelectorAll('button.sel').forEach((x) => x.classList.remove('sel'));
      b.classList.add('sel');
      renderDetail();
      if (window.matchMedia('(max-width: 760px)').matches) $('detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    ul.append(el('li', {}, b));
  };
  ul.append(el('li', { className: 'sep', textContent: `우리 편 · 장수정보 (${roster.length})` }));
  roster.filter((i) => officerVisible(i, q)).forEach(add);
  if (all) {
    ul.append(el('li', { className: 'sep', textContent: '기타 장수 · other officers' }));
    for (let i = 0; i < edit.save.officers.length; i++) if (!inRoster.has(i) && officerVisible(i, q)) add(i);
  }
}

function refreshRow(i: number) {
  const b = $('officers').querySelector<HTMLButtonElement>(`button[data-officer="${i}"]`);
  if (!b || !edit) return;
  const { dyn } = edit.officer(i);
  b.querySelector('.lv')!.textContent = `Lv${dyn.level}`;
  const sub = b.querySelector('.sub')!;
  const rest = sub.textContent!.includes(' · ') ? sub.textContent!.slice(sub.textContent!.indexOf(' · ')) : '';
  sub.textContent = className(dyn.cls) + rest;
  b.classList.toggle('edited', edited(i));
}

// ------------------------------------------------------------------ detail

function numberField(label: string, value: number, min: number, max: number, onChange: (v: number) => void, slider = false, note = ''): HTMLElement {
  const num = el('input', { type: 'number', min: String(min), max: String(max), step: '1', value: String(value), inputMode: 'numeric' });
  const row = el('div', { className: 'row2' }, num);
  if (slider) {
    const r = el('input', { type: 'range', min: String(min), max: String(max), step: '1', value: String(value) });
    r.oninput = () => {
      num.value = r.value;
      onChange(+r.value);
    };
    num.onchange = () => {
      onChange(+num.value);
    };
    row.append(r);
  } else num.onchange = () => onChange(+num.value);
  const f = el('div', { className: 'field' }, el('label', { textContent: label }), row);
  if (note) f.append(el('div', { className: 'note', textContent: note }));
  return f;
}

function changed(full = false) {
  if (full) renderDetail();
  else updateDerived();
  refreshRow(selected);
  updateDirty();
  message('');
}

let updateDerived = () => {};

function renderDetail() {
  const box = $('detail');
  box.replaceChildren();
  if (!edit) return;
  const e = edit;
  const i = selected;
  const { st, dyn } = e.officer(i);

  // header: portrait, name, static stats (BAKDATA, not in the save)
  const portrait = el('canvas', { className: 'portrait', width: 64, height: 80 });
  drawFace(portrait, st.face);
  const stats = el('div', { className: 'stats' });
  for (const [label, v] of [
    ['무력', st.strength],
    ['지력', st.intelligence],
    ['통솔', st.leadership],
  ] as [string, number][]) {
    const bar = el('div', { className: 'bar' }, el('i'));
    (bar.firstChild as HTMLElement).style.width = `${v}%`;
    stats.append(el('span', { textContent: label }), bar, el('b', { textContent: String(v) }));
  }
  const fac = dyn.flags & 0x1f;
  box.append(
    el(
      'div',
      { className: 'top' },
      portrait,
      el(
        'div',
        {},
        el('h3', { textContent: st.name }),
        el('div', { className: 'reading', textContent: `${st.reading} · #${i} · ${factionName(fac)}${dyn.flags & 0x80 ? '' : ' (비활성)'}` }),
        stats,
        el('div', { className: 'note muted', textContent: '능력치(무력·지력·통솔)는 BAKDATA.R3의 고정값이라 세이브에 없습니다. Stats are not stored in the save.' }),
      ),
    ),
  );

  // level / exp / class / troops
  const fields = el('div', { className: 'fields' });
  const troopsInput = el('input', { type: 'number', min: '0', step: '1', inputMode: 'numeric' });
  const troopsMax = el('span', { className: 'muted' });
  const refill = el('input', { type: 'checkbox', checked: true });
  fields.append(
    numberField(`레벨 Level (1–${MAX_LEVEL})`, dyn.level, 1, MAX_LEVEL, (v) => {
      e.setLevel(i, v, refill.checked);
      changed();
    }, true),
    numberField(`경험치 Exp (0–${MAX_EXP})`, dyn.exp, 0, MAX_EXP, (v) => {
      e.setExp(i, v);
      changed();
    }, true, '100이 되면 레벨이 오릅니다.'),
  );

  // class select with reachability groups
  const opts = classOptions(i, e.origClass[i], data.tables.classNames);
  const sel = el('select');
  const groups: [string, string][] = [
    ['line', '승급 계통 · promotion line'],
    ['book', '전직 가능 · via class book'],
    ['other', '기타 (게임에서 불가) · free choice'],
  ];
  for (const [reach, label] of groups) {
    const g = el('optgroup', { label });
    for (const o of opts.filter((x) => x.reach === reach)) g.append(el('option', { value: String(o.cls), textContent: `${o.name}${o.minLevel ? ` (Lv${o.minLevel}+)` : ''}` }));
    if (g.children.length) sel.append(g);
  }
  if (dyn.cls >= opts.length) sel.append(el('option', { value: String(dyn.cls), textContent: `#${dyn.cls}` }));
  sel.value = String(dyn.cls);
  const classWarn = el('div', { className: 'note warn' });
  sel.onchange = () => {
    e.setClass(i, +sel.value, refill.checked);
    changed(true);
  };
  fields.append(el('div', { className: 'field' }, el('label', { textContent: '병종 Class' }), sel, classWarn));

  troopsInput.onchange = () => {
    e.setTroops(i, +troopsInput.value);
    changed();
  };
  const maxBtn = el('button', { type: 'button', textContent: '최대' });
  maxBtn.onclick = () => {
    e.setTroops(i, e.derived(i).maxTroops);
    changed();
  };
  fields.append(
    el(
      'div',
      { className: 'field' },
      el('label', { textContent: '병력 Troops' }),
      el('div', { className: 'row2' }, troopsInput, troopsMax, maxBtn),
      el('label', { className: 'note' }, refill, ' 레벨·병종을 바꾸면 최대로 채우기'),
    ),
  );
  box.append(fields);

  const der = el('div', { className: 'derived' });
  box.append(der);

  // items
  box.append(el('h4', { textContent: '도구 Items (8칸)' }));
  const items = el('div', { className: 'items' });
  const itemOpts = () => {
    const s = el('select');
    s.append(el('option', { value: String(EMPTY_ITEM), textContent: '— 없음 —' }));
    const kinds: [number[], string][] = [
      [[0], '무기 · weapons'],
      [[5], '병법서 · books'],
      [[4], '말 · horses'],
      [[1], '전직·승급 · class items'],
      [[2], '책략 · tactics'],
      [[3], '소모품·기타 · other'],
    ];
    const seen = new Set<number>();
    for (const [types, label] of kinds) {
      const g = el('optgroup', { label });
      data.bak.items.forEach((it, id) => {
        if (types.includes(it.type) && !isPlaceholderName(it.name)) {
          g.append(el('option', { value: String(id), textContent: `${it.name}${it.power ? ` (+${it.power})` : ''}` }));
          seen.add(id);
        }
      });
      if (g.children.length) s.append(g);
    }
    const rest = el('optgroup', { label: '알 수 없음 · unknown' });
    data.bak.items.forEach((_, id) => !seen.has(id) && rest.append(el('option', { value: String(id), textContent: itemName(id) })));
    if (rest.children.length) s.append(rest);
    return s;
  };
  const held = dyn.items.filter((v) => v !== EMPTY_ITEM).length;
  for (let k = 0; k < ITEM_SLOTS; k++) {
    const s = itemOpts();
    const v = dyn.items[k];
    if (v !== EMPTY_ITEM && v >= data.bak.items.length) s.append(el('option', { value: String(v), textContent: `#${v}` }));
    s.value = String(v);
    // only one empty slot after the held items is offered, so the list stays packed
    if (v === EMPTY_ITEM && k > held) s.disabled = true;
    s.onchange = () => {
      e.setItem(i, k, +s.value);
      changed(true);
    };
    items.append(el('div', { className: 'slotsel' }, el('span', { textContent: String(k + 1) }), s));
  }
  box.append(items);

  // advanced: faction / active bit
  const facSel = el('select');
  data.tables.factionNames.forEach((n, f) => facSel.append(el('option', { value: String(f), textContent: n })));
  if (fac >= data.tables.factionNames.length) facSel.append(el('option', { value: String(fac), textContent: `#${fac}` }));
  facSel.value = String(fac);
  const active = el('input', { type: 'checkbox', checked: (dyn.flags & 0x80) !== 0 });
  const setFac = () => {
    e.setFaction(i, +facSel.value, active.checked);
    renderList();
    changed(true);
  };
  facSel.onchange = setFac;
  active.onchange = setFac;
  box.append(
    el(
      'details',
      { className: 'adv' },
      el('summary', { textContent: '고급: 소속 세력 · faction' }),
      el(
        'div',
        { className: 'fields' },
        el('div', { className: 'field' }, el('label', { textContent: '소속 세력' }), facSel),
        el('div', { className: 'field' }, el('label', { textContent: '활성 (bit 7)' }), el('label', {}, active, ' 활성')),
      ),
      el('p', { className: 'note warn', textContent: '유비와 같은 세력 + 활성이면 장수정보 목록에 나타납니다. 출진·이벤트는 시나리오가 정하므로 동료가 되는 것을 보장하지 않습니다. Only the 장수정보 list is guaranteed to follow this.' }),
    ),
  );

  updateDerived = () => {
    const d = e.officer(i).dyn;
    const v = e.derived(i);
    troopsInput.max = String(v.maxTroops);
    troopsInput.value = String(d.troops);
    troopsMax.textContent = `/ ${v.maxTroops}`;
    der.replaceChildren(
      el('span', {}, '최대 병력 ', el('b', { textContent: String(v.maxTroops) })),
      el('span', {}, '최대 책략치(MP) ', el('b', { textContent: String(v.maxMp) })),
      el('span', {}, '공격력 ', el('b', { textContent: String(v.attack) })),
      el('span', {}, '방어력 ', el('b', { textContent: String(v.defence) })),
      el('span', {}, '이동력 ', el('b', { textContent: String(v.move) })),
      el('span', { textContent: '(MP·공격·방어·이동은 세이브에 저장되지 않고 전투에서 계산됩니다; 사기 100 기준)' }),
    );
    const o = opts.find((x) => x.cls === d.cls);
    const w: string[] = [];
    if (!o || o.reach === 'other') w.push(i === HERO ? '유비는 전직할 수 없어 게임에서는 얻을 수 없는 병종입니다 (자유 선택).' : '게임에서 이 장수가 얻을 수 없는 병종입니다 (자유 선택).');
    else if (o.minLevel > d.level) w.push(`보통 Lv${o.minLevel} 이상에서 승급하는 병종입니다.`);
    if (o?.reach === 'line' && d.cls < e.origClass[i] && d.cls < 12) w.push('게임에서는 하위 병종으로 내려갈 수 없습니다.');
    classWarn.textContent = w.join(' ');
  };
  updateDerived();
}

// ------------------------------------------------------------------ save / download

async function saveToStore() {
  if (!edit || !source) return;
  const bytes = edit.bytes();
  if (source.kind === 'slot') {
    await writeSlot(files, source.slot, bytes);
    open(bytes, source, true);
    message(`슬롯 ${source.slot + 1}에 저장했습니다. Classic/Native 모드를 (다시) 열면 적용됩니다. Saved.`);
    return;
  }
  const slot = +$<HTMLSelectElement>('targetSlot').value;
  const info = listSlots(files)[slot];
  const up = source.upload;
  let ask = info.empty ? '' : `슬롯 ${slot + 1} (${info.title})을 덮어씁니다.\n`;
  if (!up.esave) ask += 'ESAVE 파일이 없어 이 슬롯의 기존 ESAVE(시나리오 진행)가 그대로 남습니다. 서로 맞지 않으면 게임이 이상하게 동작할 수 있습니다.\n';
  if (ask && !confirm(`${ask}계속할까요?`)) return;
  await writeSlot(files, slot, bytes, up.esave);
  open(bytes, { kind: 'slot', slot }, true);
  message(`슬롯 ${slot + 1}에 저장했습니다${up.esave ? ' (MSAVE + ESAVE)' : ''}. Saved.`);
}

function downloadName(): { name: string; slot: number; esave: Uint8Array | null } {
  if (source!.kind === 'slot') return { name: msaveName(source!.slot), slot: source!.slot, esave: files.get(esaveName(source!.slot)) ?? null };
  const up = source!.upload;
  return { name: up.name, slot: up.slot ?? 0, esave: up.esave };
}

// ------------------------------------------------------------------ main

async function main() {
  files = await getGameFiles($('picker'));
  for (const f of ['BAKDATA.R3', 'MAIN.EXE']) if (!files.has(f)) throw new Error(`missing ${f}`);
  data = { bak: parseBakData(files.get('BAKDATA.R3')!), tables: readEngineTables(files.get('MAIN.EXE')!) };
  const face = files.get('FACEDAT.R3');
  if (face) faceBlobs = parseBlobIndex(face, FACEDAT_COUNT);
  faceRgba = paletteToRgba(readMainPalettes(files.get('MAIN.EXE')!)[PAL.camp]);

  $('app').hidden = false;
  renderSlots();

  $<HTMLInputElement>('upload').onchange = async () => {
    const input = $<HTMLInputElement>('upload');
    if (!input.files?.length || !confirmDiscard()) return;
    try {
      const list = await Promise.all(Array.from(input.files).map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) })));
      const up = readUpload(list);
      open(up.msave, { kind: 'upload', upload: up });
    } catch (e) {
      $('loadError').textContent = (e as Error).message;
    }
    input.value = '';
  };
  $<HTMLInputElement>('money').onchange = () => {
    if (!edit) return;
    const m = $<HTMLInputElement>('money');
    edit.money = +m.value;
    m.value = String(edit.money);
    updateDirty();
  };
  $<HTMLInputElement>('money').max = String(MAX_MONEY);
  $('search').oninput = renderList;
  $('showAll').onchange = renderList;
  $('saveStore').onclick = () => {
    saveToStore().catch((e) => message(String(e), true));
  };
  $('download').onclick = () => {
    if (!edit || !source) return;
    download(downloadName().name, edit.bytes());
  };
  $('downloadZip').onclick = () => {
    if (!edit || !source) return;
    const d = downloadName();
    download(`hero-save-${d.slot + 1}.zip`, slotZip(d.slot, edit.bytes(), d.esave));
  };
  $('revert').onclick = () => {
    if (!edit || !source) return;
    open(edit.original, source, true);
    message('되돌렸습니다. Reverted.');
  };
  window.addEventListener('beforeunload', (ev) => {
    if (edit?.changed()) ev.preventDefault();
  });

  // open the first non-empty slot so the page is useful straight away
  const first = listSlots(files).find((s) => !s.empty);
  if (first) open(files.get(msaveName(first.slot))!, { kind: 'slot', slot: first.slot });
}

main().catch((e) => {
  document.body.append(el('p', { className: 'error', textContent: String(e) }));
});
