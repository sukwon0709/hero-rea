#!/usr/bin/env python3
"""Dump MSAVEn.R3S / ESAVEn.R3S / MSAVE.R3 in readable form (layout: docs/DATA.md, "Saves").

usage: python3 -I tools/savedump.py GAME_DIR SLOT          # MSAVEn + ESAVEn, with names from BAKDATA/BBKSDAT1
       python3 -I tools/savedump.py GAME_DIR new           # MSAVE.R3 (new-game header)
"""
import os
import struct
import sys

MODES = {0: 'town', 1: 'world', 2: 'palace', 3: 'battle'}
DS = 0x6A00 + 0x313A0


def cstr(b):
    b = b.split(b'\0')[0]
    try:
        return b.decode('euc-kr')
    except UnicodeDecodeError:
        return b.decode('shift_jis', 'replace')


def header(b):
    ts = b[0:5]
    print('timestamp  ', 'empty' if not any(ts) else '%02x/%02d/%02x %02x:%02x' % (ts[0], ts[1] >> 4, ts[2], ts[3], ts[4]))
    print('title      ', cstr(b[5:35]))
    p = struct.unpack_from('<8H4B', b, 0x23)
    names = ['money', '+2', 'battleOpt', '+6', '+8', 'flags', '+c', 'bgm', 'territory', 'scroll', 'chapter', 'speed']
    print('0x7a80     ', ' '.join('%s=%#x' % kv for kv in zip(names, p)))
    for name, o in (('0x7a6c', 0x37), ('0x7a76', 0x40)):
        l = b[o:o + 9]
        print(name, '    x=%d y=%d +2=%d +3=%d key=%d mode=%s map=%d entered=%d +8=%d' % (
            l[0], l[1], l[2], l[3], l[4], MODES.get(l[5] & 15, l[5]), l[6], l[7], l[8]))
    return p


def main():
    gd, slot = sys.argv[1], sys.argv[2]
    rd = lambda n: open(os.path.join(gd, n), 'rb').read()
    if slot == 'new':
        header(rd('MSAVE.R3'))
        return
    b = rd('MSAVE%s.R3S' % slot)
    p = header(b)
    bak = rd('BAKDATA.R3')
    main_exe = rd('MAIN.EXE')
    section = main_exe[DS + 0xEBC + p[10]]
    bbk = rd('BBKSDAT1.R3')[section * 0x380:]
    items = [cstr(bak[0xD00 + i * 16:0xD00 + i * 16 + 12]) for i in range(64)]
    print('actors:')
    for i in range(62):
        a = b[0x49 + i * 26:0x49 + i * 26 + 26]
        uid = a[6] | a[7] << 8
        if uid:
            kind = cstr(bak[0x1100 + (uid & 0x1FF) * 21:][:6]) if uid & 0xE00 == 0x200 else cstr(bak[(uid & 0xFF) * 13:][:8])
            print('  %2d id=%#05x %-8s at (%d,%d) rest=%s' % (i, uid, kind, a[8], a[9], a[10:].hex()))
    print('officers in a faction roster (dyn bit7):')
    for i in range(384):
        d = b[0x695 + i * 18:0x695 + i * 18 + 18]
        if d[0] & 0x80:
            st = bak[0x1100 + i * 21:0x1100 + i * 21 + 21]
            print('  %3d %-6s faction=%2d cls=%2d lv=%2d exp=%2d troops=%4d items=%s' % (
                i, cstr(st[:6]), d[0] & 31, d[7], d[8], d[9], d[5] | d[6] << 8,
                ','.join(items[x] for x in d[10:] if x != 0xFF)))
    print('towns (section %d):' % section)
    for i in range(32):
        name = cstr(bbk[i * 23:i * 23 + 8])
        print('  %2d %-8s %s' % (i, name, b[0x2195 + i * 6:0x2195 + i * 6 + 6].hex()))
    e = rd('ESAVE%s.R3S' % slot)
    w = struct.unpack_from('<8H', e, 0)
    print('ESAVE chapter=%d stage=%d block=%d group=%d area=%d mode/map=%#06x charArea=%#x charMap=%#x' % w)
    flags = [n for n in range(256) if e[0x395 + (n >> 3)] & (0x80 >> (n & 7))]
    print('ESAVE flags set:', flags)


if __name__ == '__main__':
    main()
