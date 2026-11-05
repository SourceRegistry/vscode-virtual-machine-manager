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
| 3 | `feat/vm-dashboard` | minor | testing (stacked on phase 2) |
| 4 | `feat/host-dashboard` | minor | testing (stacked on phase 3) |
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

Stacked on `feat/vm-details-sdk` (phases 1 and 2 not merged yet).

- [x] Per-VM Svelte panel (`VM: Show Details`), in the tree and overview context menus (when the provider reports details or stats) and the command palette
- [x] Header: state, power actions, console, settings
- [x] Stat tiles: uptime, processors, memory, IP, CPU now, disk I/O now
- [x] Hardware cards: disks and CD/DVD drives (with Change ISO / Eject), network adapters (MAC, IPs, "needs a guest agent" hint), port forwards, PCI devices
- [x] Live charts with uPlot (npm dependency, bundled into the webview), rolling 5 min window, sampled every 2 s:
  - [x] CPU
  - [x] Memory
  - [x] Disk throughput (read/write)
  - [x] Disk operations (read/write IOPS)
  - [x] Disk latency: average service time per request. Idle intervals are gaps, not zeros
  - [ ] Network throughput: no provider reports it yet (QEMU user networking has no counters)
- [x] "Show data" table of the last samples (accessibility)
- [x] Colors: four hues of the validated reference palette, light and dark (`src/lib/client/chartPalette.ts`); VS Code theme tokens for everything else
- [x] Polling: sequential loop (a slow provider slows it down instead of piling up), host skips the work while the tab is hidden, history resets when the VM stops or restarts
- [x] Tests: rate derivation, counter resets, tick steps, formatting, menu entries
- [x] Rendered and checked in Chrome against mocked data (dark, light, stopped)
- [ ] Manual check in VS Code against a real running VM
- [ ] Memory chart for QEMU shows the host's resident memory of the QEMU process, not guest-internal usage (needs a balloon/guest agent; not done)

## Phase 4: `feat/host-dashboard`

Stacked on `feat/vm-dashboard` (phases 1-3 not merged yet).

- [x] Overview becomes a dashboard
- [x] Summary: VMs by state (stacked bar, chips that filter the table), allocated vs available vCPU/memory across all online nodes, overcommit flagged with text and the warning color
- [x] Node cards: CPU load, memory in use, vCPUs and memory allocated to running VMs, labelled facts (QEMU version and acceleration, platform; Hyper-V host OS and VM storage)
- [x] One table of all VMs across all clusters: filter by name/host/IP, sort by state/name/host/vCPU/memory/CPU/uptime (natural order, empty values sink), CPU sparkline with the live value, details link, row actions, native context menu on every row
- [x] Bulk start / shut down / power off for the selection: counts only the VMs the action applies to, one confirmation for power off, runs in the background, one summary if some fail
- [x] Honest numbers on macOS: `os.freemem()` reported 187 MB free of 16 GB; available memory now counts free + inactive + speculative + purgeable pages (`/proc/meminfo` MemAvailable on Linux)
- [x] QEMU: the acceleration actually available (`-accel help`); on Apple Silicon the x86_64 binary offers TCG only, so the node says "Software emulation (TCG)" and VMs no longer start by failing on `hvf` (see phase 10)
- [x] CPU sampling shared by the overview and the details page no longer makes each other jumpy (minimum 1 s window)
- [x] Tests: overview logic (filter, sort, counts, allocation, eligibility), host parsers, RPC contract; rendered and exercised in Chrome (filter chip, select all, sort, bulk bar)
- [ ] Manual check in VS Code with a real QEMU VM
- [ ] Hyper-V node CPU load / facts and per-VM CPU for sparklines are untested (no Windows host); the overview polls one `getVmStats` per running VM every 3 s, which costs one PowerShell call each on Hyper-V
- [ ] Accelerator choice only filters for QEMU's own list; a per-VM setting to force an accelerator is not done

## Phase 5: `feat/qemu-network`

- [x] Port forwards: add / remove / list live via HMP `hostfwd_add` / `hostfwd_remove`, persisted in the definition (verified against real QEMU in the e2e)
- [x] Per-forward actions: copy ssh command, open in browser; show host-reachable address (`10.0.2.2`)
- [~] Guest IPs: guest agent `guest-network-get-interfaces` done (phase 2); ARP/lease fallback dropped for user networking (guest is not on the host LAN), UI hints the usual `10.0.2.15`. Revisit with bridge/vmnet NICs
- [ ] NIC editor: add/remove NICs, modes (user, bridge, vmnet on macOS) — deferred, needs multi-NIC definition; model still editable in settings

## Phase 6: `feat/qemu-import`

- [x] Import from folder (`vmm.importFromFolder`): qcow2/raw/img/vmdk/vdi/vhdx/vhd/qed disks, `vm.json` of another install, libvirt domain XML (name, memory, vCPUs, disks, CD, UEFI), UTM bundles (disks only: `config.plist` is not translated). Reference the disks in place or copy them. Disks already used by a managed VM are not offered again
- [x] Process scan (`vmm.attachRunningVm`): finds `qemu-system-*`, parses name, CPUs, memory, disks, CD, VNC port and the monitor address (`-qmp`, or `-chardev socket` + `-mon`); libvirt's inherited `fd=` sockets are recognised as unusable
- [x] Adopt when a QMP socket/port is available: full control (power, stats, media, details), badged **external**
- [x] Stop of adopted VM: guest agent/ACPI ladder, then the usual confirmed power-off (quit → SIGTERM → SIGKILL)
- [x] No QMP: observe-only (stats, power off), badged **external · observe only**, only Power off offered, hint to restart managed
- [x] `QmpClient` unix-socket support
- [x] Dedupe against managed VMs by pid
- Decisions: an adopted VM exists only while its process does (it disappears from the list when it exits, nothing could restart it faithfully); "Delete" on one only detaches (never stops it or touches its disks). QMP serves one client at a time: if another tool holds the socket the VM is attached observe-only with a warning
- Not done: translating UTM `config.plist`, importing a VM definition's NICs/firmware beyond UEFI, Windows process scan is untested

## Phase 7: `feat/passthrough`

Details page, card **Host devices** (loaded on demand: listing USB can be slow). Host-changing steps are always confirmed in a modal that lists the exact commands and warnings.

- [x] USB: list host devices (`system_profiler` on macOS, `lsusb` or sysfs on Linux), hot-plug with QMP `device_add usb-host` / `device_del`, attached state read back through `qom-list`. Refuses a device that is no longer on the host (QEMU would silently wait for it). Not persisted: re-attach after a restart. Windows: clearly unsupported. The macOS parser is written against the documented `system_profiler` JSON; the dev machine reported no USB devices, so it is covered by fixtures only
- [x] PCI VFIO (Linux only, **experimental**):
  - [x] IOMMU check, groups, current driver, boot display (`/sys/bus/pci`, `/sys/kernel/iommu_groups`)
  - [x] bind-to-`vfio-pci` helper: `pkexec` runs a short, validated script (`driver_override`, unbind, `drivers_probe`, `chown` of `/dev/vfio/<group>`); the commands are shown verbatim before running; no `sudo` fallback
  - [x] attach with `-device vfio-pci,host=…` at start (cold-plug, stored in the definition; the VM must be stopped to change it)
  - [x] warn on shared IOMMU groups, host drivers being unbound, the boot GPU
  - [x] rebind behaviour shown, never silent: the device stays on vfio-pci after the VM stops until it is detached, which returns it to its host driver (confirmed). Start checks the binding and explains instead of surfacing QEMU's terse error
- [x] macOS / Windows: clear "not supported" state with the reason
- [x] Hyper-V DDA (`Dismount-VMHostAssignableDevice` + `Add-VMAssignableDevice`, and back) with the same confirmation rules, gated by detection (Windows Server, cmdlets present). USB is reported unsupported
- [x] VFIO and DDA are marked experimental in the UI. **Not validated on real hardware**: VFIO needs a Linux host with an IOMMU, DDA a Windows Server host. Both are covered by unit tests of parsing, assessment, script building and input validation only

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
