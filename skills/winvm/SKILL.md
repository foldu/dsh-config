---
name: winvm
description: >-
  Drive jupiter's Windows 11 test guest — a persistent libvirt domain named `win`,
  reachable over ssh — to build and run Windows software for real: copy a build in,
  execute it, read stdout and exit codes, screenshot the desktop, click through an
  installer or GUI, and reset to a clean disk between runs. Use whenever a task
  needs actual Windows — a Windows-only test suite, a .exe/.msi you are developing,
  a behaviour that only reproduces on Windows, checking an app's Windows build —
  rather than Wine, cross-compilation, or reasoning about it. Runs on jupiter only.
---

# winvm — the Windows test guest on jupiter

A long-lived Windows 11 Pro VM on jupiter, driven by the `winvm` script
(`packages/winvm` in the nixos-config repo). It is a machine you can install into,
break, and reset — not a shared service, so there is nothing precious to protect
except the `base` snapshot.

Two rules:

1. **Reset before you trust a result.** A guest that has been used for three
   experiments is not the machine your test claims to run on.
2. **Look at the screen when the test is about the UI.** `Get-Process` succeeds
   while the window is invisible, off-screen, or behind a modal.

## Am I in the right place?

```sh
command -v winvm        # /run/current-system/sw/bin/winvm -- jupiter only
winvm status            # domain state + guest address
```

If `winvm` is missing you are on the wrong host or the config is not deployed;
there is no remote-URI mode. The guest is on the host's `qemu:///system` (already
handled by `winvm`) and is **not** autostarted — after a host reboot it is off
until `winvm up`.

Guest: 12 vCPU, 16 GiB, 64 GiB disk (~37 GB free), q35 + OVMF, TPM 2.0, no Secure
Boot, **no GPU** (`virtio-vga` only), local admin `win` with autologon, OpenSSH,
RDP, `qemu-ga`. ssh answers 15–30 s after a cold start (the runner below waits for
it rather than sleeping, and a `reset` run end to end is around a minute).

## The loop

```sh
winvm up                            # if it is shut off
winvm reset                         # destroy -> revert to `base` -> start
winvm ssh -- cmd /c "ver"           # cmd.exe
winvm ps 'Get-Date'                 # PowerShell, encoding-proof
```

`reset` throws away everything on the disk. Install, test, then `reset` again for
the next run — or take a snapshot once a toolchain is in place (below).

## Running something

Preferred path: a local `.ps1` plus this skill's runner. It uploads the file,
executes it, streams stdout/stderr, and exits with the script's own status:

```sh
scripts/winrun test.ps1              # exit code = the script's
scripts/winrun -o ./artifacts test.ps1   # ... and pull C:\winvm\out back
scripts/winrun -r test.ps1           # reset to base first, wait for ssh
```

The file lands in `C:\winvm\run`; have it write results to `C:\winvm\out` and `-o`
collects them. A file also gets you line numbers in error messages, which an
inline one-liner cannot.

Inline is fine for small things:

```sh
winvm ps 'Get-ChildItem C:\build | Select-Object Name,Length'
winvm ssh -- cmd /c "cd /d C:\build && mytest.exe --json"
```

**Exit codes propagate** through both forms (verified with `cmd /c exit 7` and
`ps 'exit 7'`), so `set -e` and `if ! winvm ps ...` behave.

**Quoting:** `winvm ssh` re-joins its arguments through Windows `cmd.exe`, so
nested quotes and `&`/`|`/`%` get mangled — that is the whole reason `winvm ps`
exists. Use `winvm ps` for anything containing quotes, pipes or `$`, and never
wrap a `winvm ps` payload in another `cmd /c`.

**Long jobs:** killing the local end of an ssh connection does *not* kill the
guest-side process (verified), but you lose its output. For anything over a couple
of minutes, start it in the guest, then poll:

```sh
winvm ps 'Start-Process C:\build\test.exe -ArgumentList "--suite","all" -RedirectStandardOutput C:\winvm\out\test.log -RedirectStandardError C:\winvm\out\test.err -PassThru | Select-Object Id'
winvm ssh -- cmd /c "type C:\winvm\out\test.log"
```

## Moving files

Windows ships bsdtar, so the same one-liner works in both directions and is faster
than scp for trees:

```sh
winvm ps 'New-Item -ItemType Directory -Force C:\build | Out-Null'
tar -C ./build -cf - . | winvm ssh "tar -C C:\\build -xf -"
winvm ssh "tar -C C:\\build -cf - ." | tar -C ./out -xf -
```

2 MB round-trips in well under a second; a 1 GB installer takes a few seconds.

## Looking at the GUI

```sh
virsh --connect qemu:///system screenshot win /tmp/win.png
```

Then open the PNG. **A black capture means the display blanked, not a hung
guest:** `virsh --connect qemu:///system send-key win KEY_LEFTSHIFT`, wait 2 s,
capture again. That misfires often enough that it is worth checking before
concluding anything is wrong.

Clicking and key chords: see [references/gui.md](references/gui.md) for the exact
QMP invocation (the pointer needs a ~2 s settle between move and press, one-shot).
`winvm key` sends chords: `winvm key KEY_ENTER`, `winvm key KEY_LEFTCTRL KEY_LEFTALT KEY_DELETE`
(Ctrl+Alt+Del — takes the guest to the security screen, `KEY_ESC` dismisses).

## State

- `base` is the clean Windows install: os, drivers, ssh, nothing else. Re-baseline
  after deliberately changing that state:
  `winvm down && virsh snapshot-delete win base && winvm snapshot base`.
- `winvm snapshot NAME` needs the domain shut off; `winvm reset` handles that
  itself. `winvm save NAME` / `winvm unsave NAME` suspend and resume a *running*
  guest to `~/.local/state/winvm/save/`.
- **Stopping.** `winvm down` sends ACPI; Windows ignores it after a long idle and
  `down` then destroys after 60 s. When the disk state matters, stop from inside:
  `winvm ssh -- cmd /c "shutdown /s /t 0"` then wait for `winvm status`. When it
  does not matter (tests), `reset` or `winvm down -f` is fine — reverting to `base`
  discards the mess anyway.

## What is in the guest, and is not

`winget` (v1.29), `curl`, `tar`, PowerShell 5.1, Edge, RDP, OpenSSH, qemu-ga,
Defender with real-time protection **on** (it does scan what you copy in, and will
quarantine a suspicious test binary — that is a finding, not a bug).

Not present: git, Visual Studio / MSVC, WSL, Python, Node, any GPU or Direct3D
driver (`dxdiag` shows the VirtIO adapter; D3D falls back to software WARP).

`winget install --id X --silent --accept-package-agreements --accept-source-agreements`
works over ssh and is the fast way to get prerequisites — but anything installed
disappears at the next `reset`, so either install per run or baseline a snapshot.

## Debugging a dead guest

| Symptom | Cause / fix |
| --- | --- |
| ssh refused right after start | still booting; `winvm status` shows the lease when it is up |
| ssh refused after minutes | screenshot first; if the desktop is there the network is not — `winvm reset` |
| black screenshot | display blanked — Shift key, capture again |
| desktop visible but app is not | wrong session (an installer started over ssh runs in session 0); run it in the console session |
| `winvm down` hangs 60 s | ACPI ignored — see Stopping; `down -f` or `reset` |
| guest wedged | `winvm key KEY_LEFTCTRL KEY_LEFTALT KEY_DELETE`, then Task Manager; else `winvm reset` |

## Hard rules

- **Never run `winvm install`** — it wipes the disk and reinstalls Windows. It is
  a one-time setup step, not recovery; `reset` is recovery.
- **Never delete `~/.local/state/winvm`** — the domain XML points at
  `install.iso` there and the guest will not start without it.
- **Do not spam keys at boot.** The install path presses keys to answer "press any
  key to boot from CD"; on a normal boot the same keys land on whatever has focus.
- A host reboot takes the guest with it (no autostart, no save unless you made one).

Deep detail on pointer/keyboard injection: [references/gui.md](references/gui.md).
