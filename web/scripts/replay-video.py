#!/usr/bin/env python3
"""Renders a battle replay (web/src/sim/grind/record.ts JSON) to an H.264 video and a text log.

    replay-video.py replay.json out.mp4 [--log out.txt] [--font path.ttc] [--fps 10] [--crf 27]

The map and the unit sprites are drawn from the graphics the recorder exported (decoded from the
game's own files); the overlay (turn, acting unit, action, damage, exp, the officers' panel) is
drawn with a system font. Needs Pillow and ffmpeg (or imageio-ffmpeg). The replay holds game
graphics: keep it and the video out of git.
"""

import argparse
import json
import shutil
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont

W, H = 1280, 720
CELL = 32
MAP_PX = 720
PANEL_X = MAP_PX + 12
FIELD, VISIBLE, FACING, ACTED, CONFUSED = 2, 0x20, 0x10, 0x80, 0x02
PLAYER_SLOTS = 15

# seconds each frame is shown
DUR = {'select': 0.30, 'result': 0.55, 'quiet': 0.25, 'banner': 0.45, 'talk': 1.4, 'final': 4.0}


def ffmpeg_bin():
    p = shutil.which('ffmpeg')
    if p:
        return p
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        sys.exit('no ffmpeg: pip install imageio-ffmpeg')


class Gfx:
    def __init__(self, assets):
        self.w, self.h = assets['width'], assets['height']
        pal = [tuple(c) for c in assets['palette']]
        self.pal = pal
        flat = [v for c in pal for v in c] + [0] * (768 - 48)
        self.flat = flat
        self.chips = {int(k): self.img(v, 16, 16) for k, v in assets['chips'].items()}
        self.sprites = {}
        for k, cells in assets['sprites'].items():
            entry, mirror = map(int, k.split(':'))
            self.sprites[(entry, mirror)] = cells
        self.classes = assets['classNames']
        self.map_cache = (None, None)

    def img(self, px, w, h, transparent=False):
        im = Image.new('P', (w, h))
        im.putpalette(self.flat)
        im.putdata(px)
        rgba = im.convert('RGBA')
        if transparent:
            mask = Image.new('L', (w, h))
            mask.putdata([0 if p == 0 else 255 for p in px])
            rgba.putalpha(mask)
        return rgba

    def map_image(self, chips):
        key = tuple(chips)
        if self.map_cache[0] == key:
            return self.map_cache[1].copy()
        W2 = self.w * 2
        im = Image.new('RGBA', (self.w * CELL, self.h * CELL), (0, 0, 0, 255))
        for my in range(self.h * 2):
            for mx in range(W2):
                c = self.chips.get(chips[my * W2 + mx])
                if c:
                    im.paste(c, (mx * 16, my * 16))
        self.map_cache = (key, im)
        return im.copy()

    def unit(self, u):
        mirror = 1 if (u['flags'] & FACING) == 0 else 0
        key = (u['sprite'], mirror, 'img')
        if key not in self.sprites:
            cells = self.sprites.get((u['sprite'], mirror))
            if not cells:
                return None
            im = Image.new('RGBA', (32, 32), (0, 0, 0, 0))
            order = [1, 0, 3, 2] if mirror else [0, 1, 2, 3]
            for k in range(4):
                c = cells[order[k]]  # frame 0
                im.alpha_composite(self.img(c, 16, 16, True), ((k & 1) * 16, (k >> 1) * 16))
            self.sprites[key] = im
        return self.sprites[key]


def load_font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.load_default()


def describe(f, units_by_slot, tactic_names):
    """Action text of an action frame: (actor name, line)."""
    a = units_by_slot.get(f.get('actor'))
    name = a['name'] if a else '?'
    act = f.get('action') or ''
    moved = f.get('from') and f.get('to') and list(f['from']) != list(f['to'])
    hits = f.get('hits') or []
    text = ' '.join(f.get('text') or [])
    tgt = units_by_slot.get(f.get('target')) if f.get('target') is not None else None
    if act == 'ai':
        tac = next((t for t in tactic_names if t and f'{t}계를 사용' in text or (t and f'{t}을(를) 사용' in text)), None)
        if '사용했다' in text and tac:
            act = tac
        elif any(h['slot'] != f['actor'] and h['dhp'] > 0 for h in hits):
            act = 'attack'
        else:
            act = 'move' if moved else 'wait'
    elif act == 'wait':
        act = 'move' if moved else 'wait'
    parts = []
    if moved:
        parts.append(f"({f['from'][0]},{f['from'][1]})→({f['to'][0]},{f['to'][1]})")
    if act not in ('move', 'wait'):
        parts.append(act + (f' → {tgt["name"]}' if tgt else ''))
    elif act == 'wait' and not moved:
        parts.append('대기 (wait)')
    return name, act, ' '.join(parts)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('replay')
    ap.add_argument('out')
    ap.add_argument('--log')
    ap.add_argument('--font', default='/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc')
    ap.add_argument('--fps', type=int, default=10)
    ap.add_argument('--crf', type=int, default=27)
    ap.add_argument('--preview', type=int, default=-1, help='write frame N as PNG next to out and stop')
    args = ap.parse_args()

    d = json.load(open(args.replay))
    meta, frames = d['meta'], d['frames']
    gfx = Gfx(d['assets'])
    tnames = d['assets']['tacticNames']
    f_big = load_font(args.font, 22)
    f_mid = load_font(args.font, 17)
    f_small = load_font(args.font, 14)
    f_dmg = load_font(args.font, 20)
    scale = MAP_PX / (gfx.w * CELL)

    # names of every slot seen (for targets that left the field)
    names = {}
    for f in frames:
        for u in f['units']:
            names[u['slot']] = u
    roster = []
    for f in frames:
        for u in f['units']:
            if u['slot'] < PLAYER_SLOTS and u['slot'] not in roster:
                roster.append(u['slot'])
    roster.sort()
    start_total = {}
    for u in frames[0]['units']:
        if u['slot'] < PLAYER_SLOTS:
            start_total[u['slot']] = u['level'] * 100 + u['exp']

    # running exp per turn / battle, and the log
    exp_turn = {}
    run_turn = {}
    run_battle = [0]
    acted_turn = {}  # (turn, slot) -> action kind
    log = []
    chips = None
    cur_turn = 0

    def cellbox(x, y):
        return (x * CELL * scale, y * CELL * scale, (x + 1) * CELL * scale, (y + 1) * CELL * scale)

    def render(f, idx):
        nonlocal chips
        if f.get('chips'):
            chips = f['chips']
        units = {u['slot']: u for u in f['units']}
        m = gfx.map_image(chips)
        for u in f['units']:
            if u['status'] != FIELD or (u['slot'] >= PLAYER_SLOTS and not (u['flags'] & VISIBLE)):
                continue
            s = gfx.unit(u)
            if s:
                m.alpha_composite(s, (u['x'] * CELL, u['y'] * CELL))
            # side marker: a thin coloured bar under each unit (blue ours, red enemy)
        m = m.resize((MAP_PX, MAP_PX), Image.LANCZOS)
        canvas = Image.new('RGB', (W, H), (16, 16, 24))
        canvas.paste(m.convert('RGB'), (0, 0))
        dr = ImageDraw.Draw(canvas, 'RGBA')
        for u in f['units']:
            if u['status'] != FIELD or (u['slot'] >= PLAYER_SLOTS and not (u['flags'] & VISIBLE)):
                continue
            x0, y0, x1, y1 = cellbox(u['x'], u['y'])
            col = (60, 140, 255, 230) if u['slot'] < PLAYER_SLOTS else (230, 60, 60, 230)
            frac = max(0.0, min(1.0, u['hp'] / max(1, u['maxHp'])))
            dr.rectangle((x0 + 2, y1 - 4, x1 - 2, y1 - 1), fill=(0, 0, 0, 200))
            dr.rectangle((x0 + 2, y1 - 4, x0 + 2 + (x1 - x0 - 4) * frac, y1 - 1), fill=col)
        k = f['kind']
        if k in ('select', 'result') and f.get('actor') is not None:
            fx, fy = f['from']
            tx, ty = f.get('to') or f['from']
            if (fx, fy) != (tx, ty):
                a0 = cellbox(fx, fy)
                a1 = cellbox(tx, ty)
                c0 = ((a0[0] + a0[2]) / 2, (a0[1] + a0[3]) / 2)
                c1 = ((a1[0] + a1[2]) / 2, (a1[1] + a1[3]) / 2)
                dr.line((c0, c1), fill=(255, 255, 255, 200), width=3)
                dr.rectangle(a1, outline=(255, 255, 255, 220), width=2)
            box = cellbox(*(f['from'] if k == 'select' else (tx, ty)))
            dr.rectangle(box, outline=(255, 230, 0, 255), width=3)
            if f.get('target') is not None and f['target'] in units:
                t = units[f['target']]
                dr.rectangle(cellbox(t['x'], t['y']), outline=(255, 60, 60, 255), width=3)
            if k == 'result':
                for h in f.get('hits') or []:
                    u = units.get(h['slot']) or names.get(h['slot'])
                    if not u:
                        continue
                    x0, y0, x1, y1 = cellbox(u['x'], u['y'])
                    if h['dhp'] > 0:
                        s, col = f"-{h['dhp']}", (255, 80, 80)
                    elif h['dhp'] < 0:
                        s, col = f"+{-h['dhp']}", (90, 255, 120)
                    elif h['dmorale'] > 0:
                        s, col = f"사기-{h['dmorale']}", (255, 200, 80)
                    elif h['dmorale'] < 0:
                        s, col = f"사기+{-h['dmorale']}", (120, 220, 255)
                    else:
                        s, col = '', (255, 255, 255)
                    if h['left']:
                        s += ' 퇴각'
                    if s:
                        dr.text(((x0 + x1) / 2, y0 - 2), s, font=f_dmg, fill=col, anchor='md', stroke_width=2, stroke_fill=(0, 0, 0))
                    if h['left']:
                        dr.line((x0 + 4, y0 + 4, x1 - 4, y1 - 4), fill=(255, 60, 60, 255), width=3)
                        dr.line((x1 - 4, y0 + 4, x0 + 4, y1 - 4), fill=(255, 60, 60, 255), width=3)

        # ---- panel
        px = PANEL_X
        y = 10
        foes = sum(1 for u in f['units'] if u['slot'] >= PLAYER_SLOTS and u['status'] == FIELD)
        ours = sum(1 for u in f['units'] if u['slot'] < PLAYER_SLOTS and u['status'] == FIELD)
        ph = {'player': '아군', 'enemy': '적군', 'ally': '우군', 'event': '이벤트'}[f['phase']]
        dr.text((px, y), f"{meta['battle']}  제{f['turn']}턴 / {meta['turnLimit']}", font=f_big, fill=(255, 255, 255))
        dr.text((W - 12, y + 4), ph, font=f_mid, fill=(255, 220, 120) if f['phase'] != 'enemy' else (255, 120, 120), anchor='ra')
        y += 32
        dr.text((px, y), f"아군 {ours}  적 {foes}   exp: 이번 턴 {run_turn.get(f['turn'], 0)}  전투 {run_battle[0]}", font=f_mid, fill=(200, 200, 210))
        y += 28
        dr.line((px, y, W - 12, y), fill=(80, 80, 100), width=1)
        y += 8
        # action box (fixed height)
        if k in ('select', 'result') and f.get('actor') is not None:
            a = units.get(f['actor']) or names.get(f['actor'])
            name, act, line = describe(f, {**names, **units}, tnames)
            lv = f" L{a['level']} {gfx.classes[a['cls']] if a['cls'] < len(gfx.classes) else ''}" if a else ''
            dr.text((px, y), name + lv, font=f_big, fill=(255, 230, 0) if f['actor'] < PLAYER_SLOTS else (255, 120, 120))
            dr.text((px, y + 30), line, font=f_mid, fill=(255, 255, 255))
            yy = y + 54
            if k == 'result':
                hs = []
                for h in f.get('hits') or []:
                    u = names.get(h['slot'])
                    nm = u['name'] if u else '?'
                    if h['dhp']:
                        hs.append(f"{nm} {'-' if h['dhp'] > 0 else '+'}{abs(h['dhp'])}" + (' 퇴각' if h['left'] else ''))
                    elif h['dmorale']:
                        hs.append(f"{nm} 사기{'-' if h['dmorale'] > 0 else '+'}{abs(h['dmorale'])}")
                    elif h['left']:
                        hs.append(f'{nm} 퇴각')
                if hs:
                    dr.text((px, yy), '  '.join(hs)[:60], font=f_mid, fill=(255, 150, 150))
                    yy += 22
                ex = f.get('exp') or []
                if ex:
                    dr.text((px, yy), '  '.join(f"{e['name']} +{e['gained']}exp" for e in ex)[:60], font=f_mid, fill=(120, 255, 140))
                    yy += 22
                for t in (f.get('text') or [])[:2]:
                    dr.text((px, yy), t[:44], font=f_small, fill=(200, 200, 200))
                    yy += 18
        elif k == 'msg':
            t = f['text'][0]
            yy = y
            line = ''
            for ch in t:
                if dr.textlength(line + ch, font=f_mid) > W - 12 - px:
                    dr.text((px, yy), line, font=f_mid, fill=(230, 230, 255))
                    yy += 22
                    line = ''
                line += ch
            dr.text((px, yy), line, font=f_mid, fill=(230, 230, 255))
        y = 230
        dr.line((px, y, W - 12, y), fill=(80, 80, 100), width=1)
        y += 6
        for hx, ht in ((0, '장수'), (120, 'Lv'), (160, '병력'), (330, 'MP'), (410, 'exp+'), (450, '(exp)')):
            dr.text((px + hx, y), ht, font=f_small, fill=(160, 160, 180))
        y += 20
        for s in roster:
            u = units.get(s) or names.get(s)
            if not u:
                continue
            on = s in units and units[s]['status'] == FIELD
            acting = f.get('actor') == s
            colr = (255, 230, 0) if acting else ((235, 235, 235) if on else (110, 110, 110))
            done = on and (u['flags'] & ACTED)
            dr.text((px, y), u['name'], font=f_mid, fill=colr)
            if done:
                nx = px + dr.textlength(u['name'], font=f_mid) + 6
                dr.ellipse((nx, y + 6, nx + 8, y + 14), fill=(120, 200, 120))
            dr.text((px + 120, y), f"{u['level']}", font=f_mid, fill=colr)
            bx = px + 160
            frac = max(0, min(1, u['hp'] / max(1, u['maxHp']))) if on else 0
            dr.rectangle((bx, y + 4, bx + 100, y + 16), outline=(90, 90, 110))
            dr.rectangle((bx, y + 4, bx + 100 * frac, y + 16), fill=(60, 140, 255) if frac > 0.3 else (230, 80, 60))
            dr.text((bx + 106, y), f"{u['hp']}" if on else '퇴각', font=f_small, fill=colr)
            dr.text((px + 330, y), f"{u['mp']}/{u['maxMp']}", font=f_small, fill=colr)
            g = u['level'] * 100 + u['exp'] - start_total.get(s, u['level'] * 100 + u['exp'])
            dr.text((px + 410, y), f"{g}", font=f_small, fill=(120, 255, 140) if g else colr)
            dr.text((px + 450, y), f"({u['exp']}/100)", font=f_small, fill=(150, 150, 160))
            y += 24
        dr.text((px, H - 22), f"carry {meta['carry']} · seed #{meta['seedIndex']} · bot replay (headless sim)", font=f_small, fill=(120, 120, 140))
        return canvas

    # ---- durations and the log
    seq = []
    for i, f in enumerate(frames):
        k = f['kind']
        if k == 'msg':
            t = f['text'][0]
            dur = DUR['banner'] if len(t) < 24 else DUR['talk'] + min(1.5, len(t) / 60)
        elif k == 'select':
            nxt = frames[i + 1] if i + 1 < len(frames) else None
            quiet = nxt and not nxt.get('hits') and not nxt.get('exp')
            dur = DUR['quiet'] if quiet else DUR['select']
        else:
            dur = DUR['result'] if (f.get('hits') or f.get('exp') or f.get('text')) else DUR['quiet']
        seq.append(dur)
    seq[-1] += DUR['final']

    # log text (exp per turn from a pre-pass)
    for f in frames:
        if f['kind'] == 'result':
            for e in f.get('exp') or []:
                exp_turn[f['turn']] = exp_turn.get(f['turn'], 0) + e['gained']
    by_slot = names
    for f in frames:
        if f['turn'] != cur_turn:
            if cur_turn:
                log.append(f"  turn {cur_turn} exp {exp_turn.get(cur_turn, 0)}")
            cur_turn = f['turn']
            log.append(f"=== T{cur_turn}")
        if f['kind'] == 'msg':
            log.append(f"  [msg] {f['text'][0]}")
        elif f['kind'] == 'result':
            name, act, line = describe(f, by_slot, tnames)
            def hit(h):
                nm = (by_slot.get(h['slot']) or {}).get('name', '?')
                if h['dhp']:
                    v = f"troops {-h['dhp']:+d}"
                elif h['dmorale']:
                    v = f"morale {-h['dmorale']:+d}"
                else:
                    v = ''
                return f"{nm} {v}{' RETREATS' if h['left'] else ''}".strip()
            hs = ', '.join(hit(h) for h in f.get('hits') or [])
            ex = sum(e['gained'] for e in f.get('exp') or [])
            side = 'P' if f['actor'] < PLAYER_SLOTS else 'E'
            log.append(f"  {side} {name}: {line or act}" + (f" | {hs}" if hs else '') + (f" | +{ex} exp" + (f" ({', '.join(e['name'] + ' +' + str(e['gained']) for e in f['exp'])})" if f['actor'] >= PLAYER_SLOTS else '') if ex else ''))
            if side == 'P':
                acted_turn[(f['turn'], f['actor'])] = (act, ex)
    log.append(f"  turn {cur_turn} exp {exp_turn.get(cur_turn, 0)}")

    # ---- encode
    if args.preview >= 0:
        # replay the running totals up to the frame
        pass
    ff = None
    if args.preview < 0:
        ff = subprocess.Popen([ffmpeg_bin(), '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(args.fps), '-i', '-',
                               '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'animation', '-crf', str(args.crf), '-pix_fmt', 'yuv420p', '-threads', '2',
                               '-movflags', '+faststart', args.out], stdin=subprocess.PIPE)
    clock = 0.0
    shown = 0
    for i, f in enumerate(frames):
        if f['kind'] == 'result':
            for e in f.get('exp') or []:
                run_turn[f['turn']] = run_turn.get(f['turn'], 0) + e['gained']
                run_battle[0] += e['gained']
        img = render(f, i)
        if args.preview >= 0:
            if i == args.preview:
                img.save(args.out)
                return
            continue
        clock += seq[i]
        n = round(clock * args.fps) - shown
        raw = img.tobytes()
        for _ in range(max(1 if i == 0 else 0, n)):
            ff.stdin.write(raw)
        shown += max(1 if i == 0 else 0, n)
    ff.stdin.close()
    ff.wait()

    # idle summary for the log
    if args.log:
        turns = sorted({t for t, _ in acted_turn})
        idle = {}
        for (t, s), (act, ex) in acted_turn.items():
            if act in ('wait', 'move') and ex == 0:
                idle.setdefault(s, []).append(t)
        summ = [f"{meta['battle']} (battle {meta['index']}) carry {meta['carry']} seed #{meta['seedIndex']} (rng {meta['rngSeed']:#x}): "
                f"{'WON' if meta['won'] else 'LOST ' + str(meta['loss'])} in {meta['turns']} turns, exp {meta['expTotal']}",
                'gains: ' + ', '.join(f"{g['name']} L{g['levelBefore']}->{g['levelAfter']} +{g['expGained']}" for g in meta['gains']),
                'exp per turn: ' + ' '.join(f"T{t}:{exp_turn.get(t, 0)}" for t in range(1, meta['turns'] + 1)),
                f"zero-exp turns (whole party): {[t for t in range(1, meta['turns'] + 1) if not exp_turn.get(t)]}",
                'idle unit-turns (wait/move only, no exp), by officer:']
        for s, ts in sorted(idle.items(), key=lambda kv: -len(kv[1])):
            summ.append(f"  {by_slot[s]['name']}: {len(ts)} of {sum(1 for (t, s2) in acted_turn if s2 == s)} turns: {ts}")
        summ.append(f"total idle unit-turns: {sum(len(v) for v in idle.values())} of {len(acted_turn)}")
        summ.append(f"video length {clock:.1f}s")
        open(args.log, 'w').write('\n'.join(summ) + '\n\n' + '\n'.join(log) + '\n')


if __name__ == '__main__':
    main()
