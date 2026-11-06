; Resident part of the custom-AI bridge, patched into MAIN.EXE by autobattle.ts.
; Assemble: nasm -f bin hook.asm -o hook.bin (the stub bytes, then the DGROUP bytes)
;
; 1cb6:3f7f `cmp byte [bp-3],1` (start of each computer pass in 1cb6:3f32) becomes `call stub; nop`.
; The stub (in the dead debug code at 1cb6:418f) loads the file AI the first time, then far-calls it
; at every pass, the first one included, and finally redoes the replaced compare.
;
; The blob goes to image 0000:a9a0, inside the copy-protection answer table (0000:a997, 1000 words).
; Only the startup code check reads that table (main() 0cf5:aafc -> 0cf5:a3e4 -> 0000:90f8), so it
; is free once the game runs. A DOS memory block is not used: it could sit where the far heap grows.
; The loader lives in DGROUP (the unused debug-menu strings at DS:0x3ad7) and runs with CS = DS.

bits 16

CODEPTR equ 0x3ad7          ; dword: 0000:CODESEG, the far address of the loaded AI blob
CODESEG equ 0x3ad9          ; 0 = not loaded yet, 1 = load failed, else the blob's segment
BLOBMAX equ 0x7c0           ; bytes free at image 0000:a9a0 (up to the end of the table at 0000:a997)

section stub vstart=0x418f align=1
stub:
    mov ax, [CODESEG]
    or ax, ax
    jnz .have
    push cs                  ; first time: far-call the loader, which returns the new CODESEG in AX
    call .tramp
.have:
    cmp ax, 1
    je .done
    call far [CODEPTR]
.done:
    cmp byte [bp-3], 1
    ret
.tramp:
    push ds
    push loader
    retf
stub_end:

section dgroup vstart=0x3ad7 align=1
    dw 0, 0                  ; CODEPTR, CODESEG
fname: db 'AI', 0
loader:
    mov ax, 0x3d00           ; open AI for reading
    mov dx, fname
    int 0x21
    jc .fail
    xchg bx, ax
    push ds
    mov ax, ds               ; DGROUP is image segment 0x313a: 0x0a9a is image 0000:a9a0
    sub ax, 0x313a - 0x0a9a
    mov ds, ax
    mov ah, 0x3f
    mov cx, BLOBMAX
    xor dx, dx
    int 0x21
    mov ah, 0x3e
    int 0x21
    mov ax, ds
    pop ds
    mov [CODESEG], ax
    retf
.fail:
    mov ax, 1
    mov [CODESEG], ax
    retf
dgroup_end:
