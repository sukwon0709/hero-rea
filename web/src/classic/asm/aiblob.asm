; The custom-AI bridge, loaded by hook.asm from the file AI to image 0000:a9a0 (at most 0x7c0 bytes).
; Assemble: nasm -f bin aiblob.asm -o aiblob.bin
;
; Far-called at the start of every computer pass of 1cb6:3f32, with DS = DGROUP and BP = that
; function's frame ([bp-3] = pass: 0 player side, 1 enemy). It only acts in pass 0 while the
; zero-player mode is on (DS:0x3a3c bit 0), and only when the page has turned the custom AI on:
;
;   AIORDER.BIN  written by the page: byte 0 = 0xff when the custom AI is off, else the sequence
;                number it answers, then 14 * 15 bytes, the new player unit records (DS:0xe2a2).
;   AISTATE.BIN  written here: byte 0 = sequence number (1..127), then DGROUP:0000..fff0.
;
; Every pass with the custom AI on: write AISTATE.BIN, then poll AIORDER.BIN once per timer tick
; until its first byte is the new sequence number, and copy the unit records into DGROUP. After
; about 10 seconds without an answer, the pass goes on with the game's own orders.

bits 16
org 0

UNITS     equ 0xe2a2
UNITBYTES equ 14 * 15
TIMEOUT   equ 182                ; timer ticks (18.2 per second)

entry:
    cmp byte [bp-3], 0
    jne .ret
    test byte [0x3a3c], 1
    jz .ret
    push si
    push di
    push es
    push ds
    push cs
    pop es
    call read_orders             ; page off -> nothing to do
    cmp byte [cs:buf], 0xff
    je .done
    inc byte [cs:seq]
    jns .seqok
    mov byte [cs:seq], 1
.seqok:
    ; AISTATE.BIN
    push cs
    pop ds
    mov ah, 0x3c
    xor cx, cx
    mov dx, sname
    int 0x21
    jc .done
    xchg bx, ax
    mov ah, 0x40
    mov cx, 1
    mov dx, seq
    int 0x21
    pop ds
    push ds
    mov ah, 0x40
    mov cx, 0xfff0
    xor dx, dx
    int 0x21
    mov ah, 0x3e
    int 0x21
    ; wait for the answer
    mov si, TIMEOUT
.wait:
    sti
    hlt                          ; until the next interrupt (the timer at the latest)
    call read_orders
    jc .next
    mov al, [cs:buf]
    cmp al, [cs:seq]
    jne .next
    cmp cx, 1 + UNITBYTES
    jne .next
    pop es                       ; ES = DGROUP
    push es
    push cs
    pop ds
    mov si, buf + 1
    mov di, UNITS
    mov cx, UNITBYTES
    cld
    rep movsb
    jmp short .done
.next:
    push ds
    xor ax, ax
    mov ds, ax
    mov ax, [0x46c]              ; BIOS tick count
    pop ds
    cmp ax, [cs:tick]
    je .wait
    mov [cs:tick], ax
    dec si
    jnz .wait
.done:
    pop ds
    pop es
    pop di
    pop si
.ret:
    retf

; Reads AIORDER.BIN into buf. CF set (and buf = 0xff) when it cannot be opened, else CX = bytes read.
; Keeps DS; uses AX, BX, DX.
read_orders:
    push ds
    push cs
    pop ds
    mov byte [buf], 0xff         ; "off" when the file is missing
    mov ax, 0x3d00
    mov dx, oname
    int 0x21
    jc .out
    xchg bx, ax
    mov ah, 0x3f
    mov cx, 1 + UNITBYTES + 1
    mov dx, buf
    int 0x21
    mov cx, ax
    jnc .close
    xor cx, cx
.close:
    mov ah, 0x3e
    int 0x21
    clc
.out:
    pop ds
    ret

seq:   db 0
tick:  dw 0
sname: db 'AISTATE.BIN', 0
oname: db 'AIORDER.BIN', 0
buf:   times 1 + UNITBYTES + 1 db 0
