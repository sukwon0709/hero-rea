"""Print EUC-KR strings at MAIN.EXE DGROUP offsets: dstr.py MAIN.EXE off [off...]"""
import sys
d = open(sys.argv[1], 'rb').read()
HDR, DGROUP = 0x6a00, 0x313a0
for a in sys.argv[2:]:
    o = HDR + DGROUP + int(a, 16)
    e = d.index(b'\0', o)
    print(a, repr(d[o:e].decode('euc-kr', 'replace')))
