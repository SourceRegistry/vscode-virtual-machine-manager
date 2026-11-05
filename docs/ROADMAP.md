# Roadmap

Tracks the dashboard / QEMU / remote-node work. Update the status column and checkboxes as work lands.

Status: `todo` · `in progress` · `testing` · `merged`

## Ground rules

- One branch per phase: `feat/<name>` (or `fix/<name>`), cut from `main`.
- Merge to `main` only when `npm run check` and `npm test` pass **and** the feature was exercised manually.
  The semantic-release pipeline then cuts the release.
- Conventional commits, so each merge bumps the version correctly.
- SDK changes are additive and optional so Hyper-V and the fake provider keep working.
  `VMM_API_VERSION` stays 1 unless a break is unavoidable.

## Overview

| # | Branch | Release | Status |
|---|--------|---------|--------|
| 1 | `fix/qemu-shutdown` | patch | testing |
| 2 | `feat/vm-details-sdk` | minor | testing (stacked on phase 1) |
| 3 | `feat/vm-dashboard` | minor | todo |
| 4 | `feat/host-dashboard` | minor | todo |
| 5 | `feat/qemu-network` | minor | todo |
| 6 | `feat/qemu-import` | minor | todo |
| 7 | `feat/passthrough` | minor | todo |
| 8 | `feat/hyperv-remote` | minor | todo |
| 9 | `feat/qemu-remote-ssh` | minor | todo |
| 10 | `feat/qemu-arm64` | minor | todo |

Order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 (10 is independent and can move up; it fixes slow x86 emulation on Apple Silicon). After phase 2, phases 6–9 are mostly independent and can be reordered.

## Phase 1: `fix/qemu-shutdown`

Problem: stopping a VM stays in `stopping` forever. A guest without an ACPI handler (e.g. a bare UEFI shell, an installer,
no `acpid`) ignores `system_powerdown`, and there is no timeout or escalation (`extensions/qemu/src/QemuProvider.ts`).

- [x] State flips on process exit (polled every 200 ms during shutdown). QMP events already trigger refresh; no `-no-shutdown` needed, QEMU exits on guest halt
- [x] Shutdown ladder (`extensions/qemu/src/shutdown.ts`):
  1. guest agent `guest-shutdown` (if channel connected)
  2. ACPI `system_powerdown`
  3. wait N s for `SHUTDOWN` (configurable, default 30)
  4. `timeout` error; core offers "Power Off" (no second confirmation)
  5. force stop: `quit` → SIGTERM → SIGKILL
- [x] `stopping` no longer waits 10 min: timeout is the cluster setting `shutdownTimeout` (default 30 s). Visible countdown: not done
- [x] virtio-serial guest-agent channel (`org.qemu.guest_agent.0`) on newly created VMs
- [x] Reboot uses the agent when it answers, else `system_reset`
- [x] Tests: ladder, guest agent client, args; opt-in end-to-end against real QEMU (`VMM_E2E_QEMU=1`)
- [ ] Manual check in VS Code: Power Off prompt after a timed-out shutdown
- [ ] Manual check with a real guest running qemu-guest-agent (only unit tested against a fake agent)

## Phase 2: `feat/vm-details-sdk`

Branched from `fix/qemu-shutdown` (phase 1 not merged yet): merge phase 1 first, then rebase this onto `main`.

- [x] SDK additions (all optional, `VMM_API_VERSION` unchanged):
  - [x] `getVmDetails()`: disks, CD drives, NICs, PCI devices, port forwards (`forwards` always empty until phase 5)
  - [x] `getVmStats()`: cumulative counters, consumer derives rates
  - [x] ~~`getNodeStats()`~~ not needed: `listNodes()` already carries CPU/RAM
  - [x] `ejectMedia`, `insertMedia`; `attachDevice`/`detachDevice` deferred to phase 7 (USB/PCI)
  - [x] `Capabilities.media` / `details` / `stats`, `VmInfo.mediaInserted`
- [x] QEMU: `query-block`, `query-blockstats`, `query-pci`, guest agent `guest-network-get-interfaces` (NIC IPs when an agent answers)
- [x] QEMU: host CPU% / RSS of the QEMU process (`/proc` on Linux, `ps` on macOS, PowerShell on Windows)
- [x] QEMU: new VMs get a stored MAC (`mac` in `vm.json`); older VMs show QEMU's default `52:54:00:12:34:56`
- [x] QEMU bug fix: `eject` / `blockdev-change-medium` need the device's QOM path (`qdev`) on QEMU 11. The old `id: 'cd0'` failed silently, so changing the ISO in settings of a running VM never worked
- [x] Hyper-V: `Get-VMHardDiskDrive`, `Get-VMDvdDrive`, `Get-VMNetworkAdapter`, CPU/memory from `Get-VM`, `Set-VMDvdDrive`. Disk/net counters not included (Hyper-V needs perf counters, phase 3)
- [x] Quick eject: `VM: Eject` / `VM: Change ISO…` commands, context menus (tree and overview), inline eject button on running VMs with media
- [x] Tests: parsers against real QMP output, menus, Hyper-V mapping, opt-in end-to-end against real QEMU
- [ ] **Hyper-V code is untested** (no Windows host): scripts in `extensions/hyperv/src/scripts.ts` (`VM_DETAILS`, `VM_STATS`, `SET_MEDIA`) need a run on Hyper-V
- [ ] Windows `sampleProcess` (PowerShell per sample, ~0.3 s) untested; phase 3 should sample less often there
- [ ] Manual check in VS Code: inline eject button, Change ISO dialog, status bar message

## Phase 3: `feat/vm-dashboard`

- [ ] Per-VM Svelte panel, opened from tree and overview
- [ ] Header: state, uptime, console button, power actions
- [ ] Hardware cards: disks, CD drives (with Eject / Change ISO), NICs, PCI/USB devices
- [ ] Network table: IPs, port forwards
- [ ] Live charts with uPlot (vendored), rolling 5 min window, ~2 s sampling:
  - [ ] CPU
  - [ ] RAM
  - [ ] disk throughput + IOPS
  - [ ] disk latency / stall (from blockstats time deltas)
  - [ ] net
- [ ] VS Code theme tokens for styling
- [ ] Stats polling only while panel is visible

## Phase 4: `feat/host-dashboard`

- [ ] Overview becomes a dashboard
- [ ] Hypervisor / node cards: CPU/RAM gauges, accelerator (KVM/HVF/WHPX), version
- [ ] VM state breakdown
- [ ] Sortable, filterable all-VMs table with sparklines, IPs, quick actions
- [ ] Bulk start/stop
- [ ] Allocated vs available resources

## Phase 5: `feat/qemu-network`

- [ ] Port forwards: add / remove / list live via HMP `hostfwd_add` / `hostfwd_remove`, persisted in the definition
- [ ] Per-forward actions: copy ssh command, open in browser; show host-reachable address (`10.0.2.2`)
- [ ] Guest IPs: guest agent `guest-network-get-interfaces`, fallback to ARP/lease lookup by MAC
- [ ] NIC editor: add/remove NICs, modes (user, bridge, vmnet on macOS)

## Phase 6: `feat/qemu-import`

- [ ] Import from folder: qcow2/raw/vmdk/vdi/vhdx/iso, libvirt XML, UTM bundles, existing `vm.json`; reference or copy
- [ ] Process scan: find `qemu-system-*`, parse cmdline into a `VmDefinition`
- [ ] Adopt when a QMP socket/port is available: full control, badged **external / imported**
- [ ] Stop of adopted VM: ACPI, escalate to SIGTERM only after confirmation
- [ ] No QMP: read-only (stats, kill) with hint to restart managed
- [ ] `QmpClient` unix-socket support (currently TCP only)
- [ ] Dedupe against managed VMs by pid

## Phase 7: `feat/passthrough`

- [ ] USB: list host devices (`lsusb` / `system_profiler` / PnP), hot-plug via `device_add usb-host`
- [ ] PCI VFIO (Linux only):
  - [ ] check IOMMU, groups, current driver
  - [ ] bind-to-`vfio-pci` helper (root via pkexec/sudo, always explicit confirmation)
  - [ ] attach with `-device vfio-pci`
  - [ ] warn on shared IOMMU groups
  - [ ] show rebind / unbind-on-stop behaviour, never silent
- [ ] macOS / Windows: clear "not supported" state
- [ ] Hyper-V DDA (`Add-VMAssignableDevice`) with the same confirmation rules, gated by capability detection
- [ ] Mark VFIO experimental until validated on a Linux host (cannot be fully tested on the macOS dev machine)

## Phase 8: `feat/hyperv-remote`

- [ ] Connection mode: Local, WinRM, SSH remoting (PS7)
- [ ] WinRM options: host, port, HTTPS, auth (Default, Negotiate/NTLM, Kerberos, CredSSP), user/password in SecretStorage, cert options (skip CA check, client cert)
- [ ] Credentials via `-Credential` object, never on the command line
- [ ] Remote variant of `PowerShellSession` (`Enter-PSSession` / `Invoke-Command`)
- [ ] RDP / vmconnect to the remote host address; SSPI SSO is local only, remote asks for credentials
- [ ] Prerequisites doc: `Enable-PSRemoting`, TrustedHosts, firewall

## Phase 9: `feat/qemu-remote-ssh`

- [ ] QEMU cluster over SSH: spawn and control `qemu-system` on a remote host
- [ ] QMP and VNC tunneled over SSH via system `ssh` (agent and keys), no new dependency

## Phase 10: `feat/qemu-arm64`

Problem: on Apple Silicon `-accel hvf` is invalid for `qemu-system-x86_64` (HVF only accelerates same-architecture guests), so
QEMU logs `falling back to tcg` and every VM runs in slow software emulation. The provider only knows x86_64 today
(`detect.ts` looks for `qemu-system-x86_64`; `buildArgs` hardcodes `-machine q35`, `ide-hd`/`ide-cd`, `qemu-xhci`, OVMF).

- [ ] Detect `qemu-system-aarch64` alongside x86_64; report which architectures are installed
- [ ] `arch` in `VmDefinition` (`x86_64` | `aarch64`); default to the host architecture, so Apple Silicon and arm64 Linux get native speed
- [ ] aarch64 argument set: `-machine virt` (+ `highmem`), `-cpu host` under HVF/KVM (`max` under TCG), AAVMF/edk2-aarch64 firmware (always UEFI), `virtio-blk`/`virtio-scsi` instead of IDE/AHCI, `virtio-net-pci`, `virtio-gpu-pci`, `usb-ehci`/`qemu-xhci` + `usb-kbd`/`usb-tablet` (no PS/2 on `virt`)
- [ ] CD/DVD on aarch64: `virtio-scsi` + `scsi-cd` (or `usb-storage`); keep eject/insert (QOM path from `query-block`) working
- [ ] Accelerator per architecture: only request `hvf`/`kvm`/`whpx` when the guest arch matches the host; otherwise TCG with a one-time notice that emulation is slow
- [ ] Firmware discovery for `edk2-aarch64-code.fd` / `AAVMF_CODE.fd` and a matching vars template
- [ ] Create form: architecture select (default host arch), warning when it differs from the host
- [ ] Existing x86_64 VMs untouched; settings show the architecture read-only
- [ ] Guest agent channel and QMP/VNC/serial wiring unchanged (shared with x86_64)
- [ ] Tests: argument sets per architecture, accelerator choice per host/guest pair, firmware detection; opt-in end-to-end boot of an empty aarch64 UEFI VM on an arm64 host
- [ ] Windows on arm64 hosts: out of scope until someone can test it

## Log

Record merges here: `YYYY-MM-DD  phase N  branch  version  notes`.
