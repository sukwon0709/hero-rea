# hero-rea

Reverse engineering Koei's **삼국지영걸전 / 三國志英傑傳 (Sangokushi Eiketsuden)**, Korean DOS/V release,
and porting it to the browser.

The repository contains no game data. To play, load your own copy (the `Hero.zip` package or its
`GAME` folder) in the web page; it is stored only in your browser's IndexedDB.

## Web app (`web/`)

* **Classic**: the original executables in js-dos (DOSBox compiled to WebAssembly), with a helper
  that answers the startup manual-code prompt using the table inside your `MAIN.EXE`.
  Saves written by the game are copied back to IndexedDB every few seconds.
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
