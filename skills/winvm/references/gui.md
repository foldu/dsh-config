# Driving the guest's display

There is no GPU and no SPICE: the guest renders into a `virtio-vga` framebuffer
that libvirt exposes over VNC on `127.0.0.1:5900`, and `virsh` can grab it. Two
things are therefore not available: `winvm console` (virt-viewer needs a graphical
session — from an agent shell use screenshots) and clipboard transfer.

## Capture

```sh
virsh --connect qemu:///system screenshot win /tmp/win.png
```

The guest is 1280x800 (96 DPI, one head). Check the PNG's real dimensions before
computing click coordinates — if Windows changed resolution, the divisor changes
with it.

A totally black capture almost always means the display powered down, not a hung
guest:

```sh
virsh --connect qemu:///system send-key win KEY_LEFTSHIFT
sleep 2
virsh --connect qemu:///system screenshot win /tmp/win.png
```

## Click

The pointer is a USB tablet, addressed absolutely in 0..32767 on each axis.
`x = px * 32767 / 1280`, `y = py * 32767 / 800`. The move and the press must be
separate events **with a settle in between** — sent back-to-back, the press lands
at the previous position.

```sh
click() { # click PX PY  -- guest pixel coordinates
  local x=$(( $1 * 32767 / 1280 )) y=$(( $2 * 32767 / 800 ))
  local m='{"execute":"input-send-event","arguments":{"events":['
  virsh --connect qemu:///system qemu-monitor-command win \
    "${m}{\"type\":\"abs\",\"data\":{\"axis\":\"x\",\"value\":${x}}},{\"type\":\"abs\",\"data\":{\"axis\":\"y\",\"value\":${y}}}]}}" >/dev/null
  sleep 2
  virsh --connect qemu:///system qemu-monitor-command win \
    "${m}{\"type\":\"btn\",\"data\":{\"down\":true,\"button\":\"left\"}}]}}" >/dev/null
  virsh --connect qemu:///system qemu-monitor-command win \
    "${m}{\"type\":\"btn\",\"data\":{\"down\":false,\"button\":\"left\"}}]}}" >/dev/null
}
```

`button` also takes `right` and `middle`. A double-click is two down/up pairs
without the settle between them (only the *move* needs settling).

Verify the click by capturing again — the guest may need a second or two to
repaint. A click that looks failed is usually a wrong coordinate, not a lost
event: measure the button's centre from the screenshot you just took.

## Keys

`winvm key` is `virsh send-key`, which presses all listed key names as a chord and
releases them:

```sh
winvm key KEY_ENTER
winvm key KEY_LEFTCTRL KEY_LEFTALT KEY_DELETE   # Ctrl+Alt+Del (security screen)
winvm key KEY_LEFTSHIFT                          # also wakes a blanked display
winvm key KEY_LEFTMETA KEY_R                     # Win+R (verified)
```

`KEY_ESC` dismisses the security screen. Names are Linux input-event names
(`KEY_A`, `KEY_1`, `KEY_F5`, `KEY_LEFTMETA`, ...); the guest layout is us-101, so
`KEY_Y` is `y`.

**There is no way to type arbitrary text this way.** For anything longer than a
few named keys, do not drive the GUI: write a script, or use the app's own
automation surface. If a GUI genuinely needs prose, the honest options are
`winvm console` from a human's desktop or RDP.

## When a GUI step is unavoidable

Installers and first-run wizards that refuse to run headless are the common case.
The working pattern:

1. Copy the installer in, start it as a scheduled task in the console session —
   a process started over ssh runs in session 0 and its window is invisible:

   ```sh
   winvm ps '$a = New-ScheduledTaskAction -Execute "C:\build\setup.exe" -Argument "/S"; $p = New-ScheduledTaskPrincipal -UserId "win" -LogonType Interactive -RunLevel Highest; Register-ScheduledTask -TaskName gui -Action $a -Principal $p -Force | Out-Null; Start-ScheduledTask gui'
   ```

2. Screenshot, click through, screenshot again.
3. `winvm ps 'Unregister-ScheduledTask -TaskName gui -Confirm:$false'` when done.

Dialog buttons are in the same place across that vendor's installers, so the loop
is: capture → read coordinates off the image → click → capture.
