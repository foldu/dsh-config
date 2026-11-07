---
name: ssh-sandbox
description: Run ssh, git-over-ssh, rsync and scp from inside DSH's Linux sandbox, where plain ssh aborts on a root-owned config Include and SSH_AUTH_SOCK names the local (usually locked) Bitwarden agent. Use `~/.dsh/bin/fwd-ssh` to run over the ssh-agent forwarded from the user's laptop. Use whenever a task needs an ssh connection, a remote command, git push/fetch over ssh, or rsync/scp.
---

# ssh from the DSH sandbox

Plain `ssh` fails here for two independent reasons:

1. `/etc/ssh/ssh_config` starts with `Include` of root-owned store files
   (`systemd-ssh-proxy`, libvirt's snippet where enabled). bwrap maps only the
   invoking uid, so inside the sandbox root appears as `65534` and OpenSSH
   refuses the include: `Bad owner or permissions on /nix/store/…`, exit 255,
   before any connection. ssh does not ownership-check the top-level file, so
   `-F` (user config only) avoids it.
2. `SSH_AUTH_SOCK` is `~/.bitwarden-ssh-agent.sock` from the systemd user
   session — a dead socket unless Bitwarden is running *and* unlocked. The
   agent the user actually wants is the one forwarded by their ssh session
   (dsh-chrome's tunnel); sshd writes those under `~/.ssh/agent/s.*`, one per
   connection, with a new name each time.

A third wrinkle: `~/.ssh/config` pins `~/.ssh/pubkeys/home.pub` with
`IdentitiesOnly yes`, and that key lives in Bitwarden, not in the forwarded
agent. The forwarded agent holds `barnabas@home` (and the GitHub/Codeberg/lab
keys), which the home hosts accept.

## Use the wrapper

```
~/.dsh/bin/fwd-ssh venus.home.5kw.li 'uptime'
~/.dsh/bin/fwd-ssh -o BatchMode=yes saturn 'systemctl --user status dsh-web'
GIT_SSH_COMMAND=$HOME/.dsh/bin/fwd-ssh git push
rsync -e $HOME/.dsh/bin/fwd-ssh -a dir/ host:dir/
scp -S $HOME/.dsh/bin/fwd-ssh file host:path
```

It picks the newest `~/.ssh/agent/s.*` socket whose client answers
`ssh-add -l`, then execs
`ssh -F ~/.ssh/config -o IdentitiesOnly=no …`. Pass your own `-F` or
`IdentitiesOnly=` to override. `FWD_SSH_AGENT=/path/to/sock` forces a
specific forwarded socket. With no live forwarded session it falls back to the
ambient `SSH_AUTH_SOCK` (Bitwarden, so the vault must be unlocked).

New hosts: `~/.ssh` is read-only in the sandbox, so an unknown host key cannot
be saved — add `-o UserKnownHostsFile=/tmp/known_hosts -o StrictHostKeyChecking=accept-new`.

## Notes

- Needs a live forwarding session (dsh-chrome, or any `ssh -A` login into this
  machine). `ssh-add -l` against the chosen socket lists the laptop's keys.
- Do not try to edit `~/.ssh` (config, known_hosts) from the sandbox; it is
  read-only. Write copies under `/tmp` or `~/.cache` instead.
- Permanent fix for the config half, if the user wants plain `ssh` to work in
  the sandbox: `programs.ssh.systemd-ssh-proxy.enable = false;` in the NixOS
  config — the same move as `virtualisation.libvirtd.sshProxy = false;` already
  in `nixos/common/libvirt.nix`. That removes the root-owned Include; the agent
  and identity problems above would still need solving separately.
