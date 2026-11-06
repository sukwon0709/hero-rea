# hero-rea

Reverse engineering Koei's **삼국지영걸전 / 三國志英傑傳 (Sangokushi Eiketsuden)**, Korean DOS/V release,
and porting it to the browser.

The repository contains no game data. To play, load your own copy (the `Hero.zip` package or its
`GAME` folder) in the web page; it is stored only in your browser's IndexedDB.

## Web app (`web/`)

* **Classic**: the original executables in js-dos (DOSBox compiled to WebAssembly), with a helper
  that answers the startup manual-code prompt using the table inside your `MAIN.EXE`.
  Saves written by the game are copied back to IndexedDB every few seconds.
  The battle menu gets a **자동전투** (AI auto-battle) entry: the computer then plays your units
  every turn with the game's own AI, until you press any key during its moves.
  With **커스텀 AI** ticked above the game, the page's own commander gives the orders instead:
  it focuses the enemy commander or the weakest nearby enemy and pulls weak units back to villages
  and forts to recover (`web/src/commander.ts`).
  Under **전략** you can describe your own tactics in words ("관우는 유비를 지켜, 장비는 적 대장만 노려");
  Claude turns them into the commander's settings with one API call (your own Anthropic API key,
  kept only in your browser), and every turn after that runs locally (`web/src/strategyprompt.ts`).
  Situational instructions ("적 대장 병력이 절반 아래면 전원 돌격") become rules checked every turn;
  설정 보기 lists the settings in Korean, with the parts of your prompt the AI could not apply.
* **Native** (in progress): a TypeScript reimplementation of the engine that reads the original data files.

```bash
cd web
npm install
npm run dev      # http://localhost:5173
npm run build    # static site in web/dist
```

## Reverse engineering

* [`docs/FORMATS.md`](docs/FORMATS.md): file inventory and data formats (LS11 archives, fonts, text encoding, …)
* [`docs/ENGINE.md`](docs/ENGINE.md): notes on `MAIN.EXE` internals (copy protection, …)
* [`tools/`](tools): Python tools. `ls11.py` unpacks LS11 archives; `mz.py` loads an MZ executable with
  relocations and disassembles 16-bit code with Capstone (`python3 tools/mz.py MAIN.EXE 0cf5:a3e4 80`).
