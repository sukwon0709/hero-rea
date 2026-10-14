#!/usr/bin/env python3
"""Disassembler for the scenario event scripts (SNR0D..SNR4D.R3 + SNR0M..SNR4M.R3).

Usage:  python3 -I tools/snrdis.py GAME_DIR [chapter [stage]] [--no-text] [--raw]

Prints, for every chapter/stage: the block (scene) table, the event records of every block
(trigger, group, parameters) and a disassembly of the event code with message text decoded
(EUC-KR).  Format and opcode semantics: docs/SCRIPT.md.  The interpreter loop is
MAIN.EXE 0cf5:8794 (Ghidra 1cf5:8794); handler addresses below are image seg:off.
"""
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ls11  # noqa: E402

# Operand letters: b=u8, w=u16, m=message id (u16), o=officer id (u16), f=flag number (u8).
# Variable-length opcodes (0x03, 0x20, 0x21, 0x22, 0x32) are decoded by dedicated code.
OPS = {
    0x00: ('TALK', 'm', 0x8a10),
    0x01: ('MOVE', 'obbb', 0x8a32),
    0x02: ('MENU_ADD', 'b', 0x8a85),
    0x03: ('BATTLE_SETUP', None, 0x8aa2),
    0x04: ('WEATHER', '', 0x8bec),
    0x05: ('SCREEN_MAP', '', 0x97cc),
    0x06: ('SCREEN_TEXT', '', 0x8bf8),
    0x07: ('PICTURE', 'bb', 0x8c03),
    0x08: ('NARRATE', 'm', 0x8c22),
    0x09: ('MAP', 'w', 0x97d5),
    0x0a: ('PLACE', 'obbb', 0x8c7c),
    0x0b: ('CAPTION', 'm', 0x8cb2),
    0x0c: ('NOP_MSG', 'wm', 0x8ceb),
    0x0d: ('TITLE', 'm', 0x8d21),
    0x0e: ('STAGE_TITLE', 'm', 0x8d58),
    0x0f: ('GOTO_BLOCK', 'b', 0x8da7),
    0x10: ('DUEL', 'oo', 0x8dd2),
    0x11: ('BATTLE_END', 'w', 0x8e18),
    0x12: ('NEXT_CHAPTER', '', 0x8e6b),
    0x13: ('LEAVE_GROUP', '', 0x97f6),
    0x14: ('SET_FLAG', 'fb', 0x8e92),
    0x15: ('ASK', 'bb', 0x8ec6),
    0x16: ('UNIT_ATTACK', 'oo', 0x8f05),
    0x17: ('INPUT', 'b', 0x8f47),
    0x18: ('REMOVE', 'o', 0x8f6e),
    0x19: ('OP19', 'w', None),
    0x1a: ('REINFORCE', 'o', 0x8f82),
    0x1b: ('ADD_ITEM', 'b', 0x8fb2),
    0x1c: ('SET_AI', 'obbb', 0x8ff6),
    0x1d: ('SET_PREV_MAP', 'wbb', 0x9098),
    0x1e: ('CLEAR_CHARS', '', 0x90c7),
    0x1f: ('PLACE_TOWNSFOLK', '', 0x90d2),
    0x20: ('SORTIE', None, 0x90e3),
    0x21: ('IF', None, 0x9123),
    0x22: ('BATTLE_UNITS', None, 0x91bd),
    0x23: ('FORMATION', '', 0x9341),
    0x24: ('SET_FORCE', 'ob', 0x9349),
    0x25: ('CHOOSE', 'm', 0x9385),
    0x26: ('MAP_CHIP', 'bbb', 0x947d),
    0x27: ('MAP_EFFECT', 'bbb', 0x94b8),
    0x28: ('UNIT_FORCE', 'ob', 0x94f3),
    0x29: ('GAME_OVER', '', 0x980e),
    0x2a: ('ENDING', 'b', 0x9826),
    0x2b: ('DATA', 'bw', 0x952d),
    0x2c: ('REDRAW', '', 0x956d),
    0x2d: ('HALVE', 'bb', 0x95a1),
    0x2e: ('SET_LEADER', 'obbb', 0x95c3),
    0x2f: ('SET_CG', 'ob', 0x95f0),
    0x30: ('OBJECTIVE', 'm', 0x962c),
    0x31: ('OP31', '', None),
    0x32: ('SET_LIST', None, 0x964d),
    0x33: ('BATTLE_OP33', '', 0x968d),
    0x34: ('BATTLE_OP34', '', 0x9698),
    0x35: ('BATTLE_OP35', 'ob', 0x96a3),
    0x36: ('SAVE_STATE', '', 0x96bc),
    0x37: ('OFFICER_FLAG', 'ob', 0x96d9),
    0x38: ('MUSIC', 'b', 0x96f7),
    0x39: ('ADD_STAT', 'ob', 0x9712),
    0x3a: ('SET_STAT', 'ob', 0x972f),
    0x3b: ('WALK_TO', 'bb', 0x9847),
    0x3c: ('FOCUS', 'o', 0x974c),
    0x3d: ('SAVE_PROMPT', 'b', 0x975e),
    0xff: ('END', '', 0x9774),
}

TRIGGERS = {
    0: 'auto', 1: 'default', 2: 'location', 3: 'talk', 4: 'adjacent', 5: 'destination',
    6: 'unit_at', 7: 'target_defeated', 8: 'leader_defeated', 9: 'turn', 0x0b: 'unit_in_area',
    0x0c: 'unit_defeated',
}

MSG_OPS = {0x00, 0x08, 0x0b, 0x0c, 0x0d, 0x0e, 0x25, 0x30}


def u16(d, o):
    return struct.unpack_from('<H', d, o)[0]


def ins_len(d, o):
    """Instruction length in bytes (opcode included)."""
    op = d[o]
    if op == 0x03:
        return 1 + 11 + 30 * 9
    if op == 0x22:
        return 1 + 1 + 30 * 13
    if op == 0x20:
        return 2 + (d[o + 1] & 0x7f)
    if op == 0x21:
        n1 = d[o + 2]
        return 3 + n1 + 1 + d[o + 3 + n1]
    if op == 0x32:
        return 2 + d[o + 1]
    spec = OPS.get(op, (None, None))[1]
    if spec is None:
        raise ValueError(f'unknown opcode {op:#04x} at {o:#x}')
    return 1 + sum(2 if c in 'wmo' else 1 for c in spec)


def block_offsets(d):
    out = []
    o = 0
    while True:
        v = u16(d, o)
        o += 2
        if v == 0xffff:
            return out
        out.append(v)


def records(d, bo):
    out = []
    o = bo
    while d[o] != 0xff:
        r = d[o:o + 10]
        out.append({
            'trigger': r[0], 'group': r[1] & 0x7f, 'resident': bool(r[1] & 0x80),
            'p1': u16(r, 2), 'p2': u16(r, 4), 'p3': u16(r, 6), 'code': bo + u16(r, 8)})
        o += 10
    return out


class Messages:
    def __init__(self, data):
        self.d = data
        n = u16(data, 0) // 2
        self.bases = []
        for i in range(n):
            b = u16(data, 2 * i)
            # 16-bit table: MAIN.EXE 0cf5:7b30 hard-codes +0x10000 for bases 0x59d0/0x1029
            # (SNR3M); equivalently, a base smaller than its predecessor has wrapped.
            if self.bases and b < self.bases[-1]:
                b += 0x10000
            self.bases.append(b)

    def cstr(self, off):
        e = self.d.index(b'\0', off)
        return self.d[off:e], e + 1

    def text(self, stage, mid):
        return dec(self.cstr(self.bases[stage] + mid)[0])

    def talk(self, stage, mid):
        p = self.bases[stage] + mid
        out = []
        while True:
            sp = u16(self.d, p)
            p += 2
            if sp == 0xffff:
                return out
            s, p = self.cstr(p)
            out.append((sp, dec(s)))


def dec(b):
    return b.decode('euc-kr', 'replace').replace('\r\n', '\\n').replace('\n', '\\n')


def fmt_ins(d, o, msgs, stage, text=True):
    op = d[o]
    name, spec, _ = OPS[op]
    L = ins_len(d, o)
    p = o + 1
    args = []
    extra = []
    if op == 0x03:
        a, b, c, _x, v1, = d[p], d[p + 1], d[p + 2], d[p + 3], d[p + 4]
        vid = u16(d, p + 5)
        d1 = d[p + 8]
        did = u16(d, p + 9)
        args.append(f'hexflag={a} b={b} c={c} victory_target=#{vid}{"" if v1 else "(off)"} defeat_target=#{did}{"" if d1 else "(off)"}')
        q = p + 11
        for i in range(30):
            uid = u16(d, q)
            x, y, side, cen, cfl, f4, f2 = d[q + 2:q + 9]
            if uid != 0xffff:
                cond = f' if flag[{cfl}]' if cen else ''
                extra.append(f'      unit {uid:3d} at ({x},{y}) side={side}{" (enemy)" if side == 0 else ""} a={f4} b={f2}{cond}')
            q += 9
    elif op == 0x22:
        args.append(f'side={d[p]}' + (' (enemy)' if d[p] == 0 else ' (allied)'))
        q = p + 1
        for i in range(30):
            uid = u16(d, q)
            x, y, cen, cfl, f4, f2, kind = d[q + 2:q + 9]
            prm = u16(d, q + 9)
            a2, b2 = d[q + 11], d[q + 12]
            if uid != 0xffff:
                cond = f' if flag[{cfl}]' if cen else ''
                extra.append(f'      unit {uid:3d} at ({x},{y}) a={f4} b={f2} kind={kind} param={prm:#06x} {a2} {b2}{cond}')
            q += 13
    elif op == 0x20:
        n = d[p]
        lst = list(d[p + 1:p + 1 + (n & 0x7f)])
        args.append(('reset ' if n & 0x80 else '') + ' '.join(str(x) for x in lst))
    elif op == 0x21:
        skip = d[p]
        n1 = d[p + 1]
        on = list(d[p + 2:p + 2 + n1])
        n2 = d[p + 2 + n1]
        off = list(d[p + 3 + n1:p + 3 + n1 + n2])
        conds = [f'flag[{f}]' for f in on] + [f'!flag[{f}]' for f in off]
        args.append(' && '.join(conds) + f' else skip {skip}')
    elif op == 0x14:
        # 0cf5:8e92: value 0 sets the flag, anything else clears it
        args.append(f'flag[{d[p]}] = {1 if d[p + 1] == 0 else 0}')
    elif op == 0x15:
        args.append(f'if answer == {"yes" if d[p] else "no"} skip {d[p + 1]}')
    elif op == 0x32:
        n = d[p]
        args.append(' '.join(str(x) for x in d[p + 1:p + 1 + n]))
    else:
        for c in spec:
            if c in 'wmo':
                v = u16(d, p)
                p += 2
                args.append(f'msg:{v:#x}' if c == 'm' else (f'#{v}' if c == 'o' else f'{v:#x}'))
            else:
                args.append(str(d[p]))
                p += 1
    line = f'  {o:05x}: {d[o:o + min(L, 8)].hex(" "):<24}{"+" if L > 8 else " "} {name} {", ".join(args)}'
    out = [line] + extra
    if text and op in MSG_OPS and msgs:
        mid = u16(d, o + 3) if op == 0x0c else u16(d, o + 1)
        try:
            if op == 0x00:
                for sp, s in msgs.talk(stage, mid):
                    out.append(f'      [{sp}] {s}')
            else:
                out.append(f'      "{msgs.text(stage, mid)}"')
        except (ValueError, IndexError, struct.error) as e:
            out.append(f'      <message error {e}>')
    return out, L


def dis_stage(d, msgs, stage, text=True):
    out = []
    blocks = block_offsets(d)
    for bi, bo in enumerate(blocks):
        recs = records(d, bo)
        end = blocks[bi + 1] if bi + 1 < len(blocks) else len(d)
        out.append(f' block {bi} @{bo:#x}')
        labels = {}
        for ri, r in enumerate(recs):
            t = TRIGGERS.get(r['trigger'], f't{r["trigger"]}')
            out.append(f'   rec {ri:2d}: group {r["group"]}{"R" if r["resident"] else " "} {t:<16} '
                       f'p1={r["p1"]:#06x} p2={r["p2"]:#06x} p3={r["p3"]:#06x} -> {r["code"]:#x}')
            labels.setdefault(r['code'], []).append(ri)
        o = min(r['code'] for r in recs) if recs else end
        while o < end:
            if o in labels:
                out.append(f'  rec {",".join(map(str, labels[o]))}:')
            lines, L = fmt_ins(d, o, msgs, stage, text)
            out.extend(lines)
            o += L
    return out


def main():
    argv = [a for a in sys.argv[1:] if not a.startswith('--')]
    text = '--no-text' not in sys.argv
    gdir = argv[0]
    chs = [int(argv[1])] if len(argv) > 1 else range(5)
    for ch in chs:
        stages = ls11.unpack(open(os.path.join(gdir, f'SNR{ch}D.R3'), 'rb').read())
        msgs = Messages(open(os.path.join(gdir, f'SNR{ch}M.R3'), 'rb').read())
        sts = [int(argv[2])] if len(argv) > 2 else range(len(stages))
        for st in sts:
            print(f'=== chapter {ch} stage {st} ({len(stages[st])} bytes, message base {msgs.bases[st]:#x})')
            print('\n'.join(dis_stage(stages[st], msgs, st, text)))


if __name__ == '__main__':
    main()
