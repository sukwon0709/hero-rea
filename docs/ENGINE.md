# Engine notes

Addresses are `segment:offset` in the loaded image (load segment 0, i.e. file offset = header size + linear address).
`MAIN.EXE` header is 0x6A00 bytes; segments seen in relocations: 0x0000, 0x0CF5, 0x1CB6, 0x2CB4, 0x30B9, 0x313A.

## Copy protection (Korean release)

At startup `MAIN.EXE` shows `CODE:_  INPUT CODE [火地金]`.

* `0CF5:A3E4` loops up to 3 times: `r = rand() % 1000`, then calls `0000:88E0(hundreds, tens, ones)`.
* `0000:88E0` draws the prompt in text mode. Digits are shown as characters from the table at
  `0000:893B` (Big5): 金 0, 木 1, 水 2, 火 3, 土 4, 日 5, 月 6, 天 7, 地 8, 人 9. It reads up to 5 typed
  characters into `0000:890D`.
* `0000:90F8(r)` converts `word[0000:A997 + 2r]` to decimal (always 5 digits, 10008–32754) and
  compares it with the typed text.

So the answer for `[火地金]` is the decimal value of table entry 380. The Classic page reads the table
from the player's own `MAIN.EXE` and shows the answer when the three characters are clicked.
