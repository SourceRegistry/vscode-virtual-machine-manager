# Roadmap

Tracks the dashboard / QEMU / remote-node work. Update the status column and checkboxes as work lands.

Status: `todo` · `in progress` · `testing` · `merged`

## Goal

**Be the best VM extension for VS Code**: trustworthy first, then the features developers reach for.

1. **Trust (phase 11):** everything shipped is verified on real hardware where we have it, and honestly labelled where we do not.
2. **Dev workflow (phases 12-14):** snapshots, Remote-SSH into a VM, cloud images with cloud-init.
3. **Reach (phases 9, 19, 8):** remote hosts and libvirt.

Done when: phase 11 has no open box we can close on this Mac, and a new user can create a cloud-image VM, snapshot it and open it in Remote-SSH without leaving VS Code.

Working now: **phase 11**. Next: phase 12.

## Ground rules

- One branch per phase: `feat/<name>` (or `fix/<name>`), cut from `main`.
- Merge to `main` only when `npm run check` and `npm test` pass **and** the feature was exercised manually.
  The semantic-release pipeline then cuts the release.
- Conventional commits, so each merge bumps the version correctly.
- SDK changes are additive and optional so Hyper-V and the fake provider keep working.
  `VMM_API_VERSION` stays 1 unless a break is unavoidable.

## Overview

Phases 1-10 are built (most still need a manual check). Phases 11-20 are the backlog; 8 and 9 are the remote-host phases.

### Built / in testing

| # | Branch | Release | Status |
|---|--------|---------|--------|
| 1 | `fix/qemu-shutdown` | patch | testing |
| 2 | `feat/vm-details-sdk` | minor | testing (stacked on phase 1) |
| 3 | `feat/vm-dashboard` | minor | testing (stacked on phase 2) |
| 4 | `feat/host-dashboard` | minor | testing (stacked on phase 3) |
| 5 | `feat/qemu-network` | minor | testing (status was stale; code and tests done) |
| 6 | `feat/qemu-import` | minor | testing (status was stale; code and tests done) |
| 7 | `feat/passthrough` | minor | testing (status was stale; code and tests done) |
| 10 | `feat/qemu-arm64` | minor | testing |

### Backlog, highest value first

Value = how much it moves "best VM extension for VS Code", weighed against effort. **Mac** = can be built and tested on the dev Mac.

| Rank | Phase | Branch | Why it ranks here | Mac |
|---|---|---|---|---|
| 1 | 11 | `fix/validate-existing` | Trust: unverified code and open manual checks undercut everything else | partly |
| 2 | 12 | `feat/snapshots` | First thing dev/test users reach for; absent today | yes |
| 3 | 13 | `feat/remote-ssh-connect` | The feature only a VS Code extension can offer; small effort | yes |
| 4 | 14 | `feat/provisioning` | Image downloader + cloud-init removes the slow ISO install | yes |
| 5 | 9 | `feat/qemu-remote-ssh` | Remote/headless hosts are the main reason to want this in an editor | yes (localhost) |
| 6 | 19 | `feat/libvirt-provider` | One provider covers most Linux KVM users | partly |
| 7 | 8 | `feat/hyperv-remote` | Remote Hyper-V hosts; large Windows audience, but no Windows host to test | no |
| 8 | 16 | `feat/guest-integration` | Guest memory, run/copy, clipboard; makes VMs feel integrated | partly |
| 9 | 18 | `feat/dev-ux` | Countdown, notifications, logs, API; cheap polish, wide effect | yes |
| 10 | 15 | `feat/disk-management` | Resize/convert/export; useful, not a differentiator | yes |
| 11 | 17 | `feat/qemu-network-v2` | NIC editor, bridge/vmnet; privileges make it costly on macOS | partly |
| 12 | 20 | `feat/more-providers` | VMware, VirtualBox, Parallels, XCP-ng, Nutanix; big but each is its own project | mostly no |

Phase numbers stay stable (they name sections and branches); the rank is the build order. Phases 5-7 and 10 are built but their leftovers sit in their own sections.

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
- [x] Real guest running qemu-guest-agent: verified 2026-11-09 with Debian 12 arm64 on HVF (`extensions/qemu/test/guest.e2e.test.ts`): the agent answers, reports the NIC address, and *Shut Down* ends in `stopped` without the force-stop path

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

- [x] Detect `qemu-system-aarch64` alongside x86_64 (`QemuInstallation.archs`, each with its binary, accelerators and firmware); the node shows the guest architectures and which are native
- [x] `arch` in `VmDefinition` (absent = x86_64); new VMs default to the host architecture, so Apple Silicon and arm64 Linux get native speed
- [x] aarch64 argument set (`arch.ts` + `buildArgs`): `-machine virt`, `-cpu host` under HVF/KVM (`max` under TCG), edk2/AAVMF UEFI always, `virtio-blk-pci`, virtio-scsi + `scsi-cd` for the CD, `virtio-gpu-pci`, `qemu-xhci` + `usb-kbd` + `usb-tablet`
- [x] CD/DVD on aarch64: eject/insert verified against a real ARM64 VM
- [x] Accelerator per architecture: hvf/kvm/whpx only for a guest of the host's architecture, otherwise TCG (also overrides a forced accelerator that cannot work)
- [x] Firmware discovery: `edk2-aarch64-code.fd` / `AAVMF_CODE.fd` with `edk2-arm-vars.fd` / `AAVMF_VARS.fd` (aarch64 has no `-aarch64-vars` file; the 64 MiB sizes match)
- [x] Create form: architecture select (only when both are installed), labelled native / emulated with the slowdown warning; x86 form defaults (BIOS, SATA, e1000, VGA) are replaced by their ARM equivalents
- [x] Existing x86_64 VMs untouched; settings show the architecture read-only, and firmware/disk controller/display read-only on ARM
- [x] Guest agent channel and QMP/VNC/serial wiring unchanged; import of libvirt/`vm.json` and attach read the architecture; unsupported ones (ppc64, riscv…) are refused clearly
- [x] Tests: argument sets per architecture, accelerator choice per host/guest pair, CPU choice, firmware detection, hardware normalisation; e2e boots an empty ARM64 UEFI VM natively on an arm64 host
- [~] One-time "emulation is slow" notice: the create form and settings say so and the VM list marks emulated guests, but there is no pop-up
- [ ] Windows on arm64 hosts: out of scope until someone can test it
- Not verified: a full guest OS install on ARM64 (only firmware boot, devices, CD hot-swap), KVM on arm64 Linux, AAVMF on Debian/Ubuntu (path knowledge only)

## Best-in-class backlog (phases 11-20)

Gap analysis: [GAPS.md](GAPS.md). Sections are in phase-number order; build order is the rank table in the Overview. Phases 8 and 9 belong to this backlog too.
**Dev Mac** = Apple Silicon macOS with QEMU (HVF for arm64 guests, TCG for x86_64). "Local" below means testable on that machine.

### Phase 11: `fix/validate-existing`  (Local: partly)

Trust first. Close the open "manual check" items before adding features.
- [x] VS Code smoke test (`npm run test:integration`) passed 2026-11-10 on this Mac against the installed VS Code, using `VSCODE_EXECUTABLE_PATH="/Applications/Visual Studio Code.app/Contents/MacOS/Code"` (the default download of 340 MB timed out). It proves activation, provider registration, every contributed command has a handler, the overview opens. It does **not** drive a real VM or click anything
- [~] Manual pass in VS Code on the Mac, 2026-11-10 (QEMU, Alpine 3.24 arm64 ISO, HVF), driven by the maintainer: add cluster (QEMU detected), create (ARM64 native default), boot to Alpine, graphical and serial consoles, Show Details and charts, Overview (summary, filter, sort, bulk bar), Shut Down timing out into the Power Off prompt, attach to a running external VM: **all work**. Eject / Change ISO works **but needed a window reload first** (see below). Port forward add/persist not checked yet
- [~] Eject / Change ISO needed a VS Code reload in the manual pass. Likely the missing CD/DVD drive on VMs created without an ISO (fixed in phase 12, see there); confirm on a VM created before and after the fix. Original note: Eject / Change ISO needed a VS Code reload before it worked in the manual pass. Cause not found; reproduce on a fresh profile (`/private/tmp/vmm-dev`), check the context keys that gate the inline button and menu entries
- [ ] Still to check by hand: port forward add, remove and persistence after restart
- [x] (superseded, kept for reference) Manual pass in VS Code against real QEMU VMs: phases 1-7 and 10 unchecked boxes (Power Off prompt, eject button, charts, overview bulk actions)
- [x] Guest agent test against a real guest: done 2026-11-09, opt-in `VMM_E2E_GUEST_IMAGE=<cloud image> npx vitest run extensions/qemu/test/guest.e2e.test.ts` (seed via cloud-init `cidata` ISO; the `-smbios ds=nocloud;s=http://` form fails on Debian 12's cloud-init 22.4)
- [x] Verified 2026-11-09 on the Mac: `npm run check`, `npm test` (300 pass), opt-in QEMU e2e (6 pass)
- [ ] Full guest OS install on ARM64 (only firmware boot verified so far)
- [x] Proxmox provider: verified status written down 2026-11-09 (`extensions/proxmox/README.md`): unit tests use a mocked `pve-client`, nothing has run against a live server
- [ ] Proxmox provider: run against a real server (HTTPS token, session ticket, OIDC, VNC and serial consoles, power tasks, create). Not possible on this Mac without a Proxmox host; ask whoever has one
- [ ] Merge or close the stacked branches (phases 1-4)
- [ ] Hyper-V, VFIO, DDA, Windows `sampleProcess`: **Not local** (need a Windows / Linux IOMMU host); keep marked experimental/untested
- [~] CI: `qemu-e2e` job added to `.github/workflows/ci.yml` (ubuntu + macos, non-blocking via `continue-on-error`); **never run on GitHub yet**. Make it blocking once green on both. Still to do: a Windows job for Hyper-V script syntax

### Phase 12: `feat/snapshots`  (Local: yes)

Status: **in progress** on `feat/snapshots`. QEMU snapshots work end to end on this Mac; the UI is built but not yet clicked through by hand.

- [x] SDK (optional, additive): `Snapshot`, `Capabilities.snapshots`, `Capabilities.snapshotRevertNeedsStopped`, `listSnapshots` / `createSnapshot` / `revertSnapshot` / `deleteSnapshot`
- [x] QEMU, disk-only qcow2 internal snapshots (`extensions/qemu/src/snapshots.ts`): stopped VM through `qemu-img snapshot -c/-a/-d` and `qemu-img info -U`; running VM through QMP `blockdev-snapshot-internal-sync` / `-delete-internal-sync` and `query-block`. All disks or none (rolled back on failure); only snapshots present on every disk are listed; names validated and unique (case-insensitive); raw disks and attached-from-outside VMs refused with the reason
- [x] Revert needs the VM stopped (the snapshot has no memory). The core asks, powers off, then reverts (`Capabilities.snapshotRevertNeedsStopped`)
- [x] Core: `VM: Take Snapshot…`, `Revert to Snapshot…`, `Delete Snapshot…` (palette, tree and Overview context menus, same entries in both), Snapshots card on the details page, shared confirmation flow (`src/extension/snapshots/flow.ts`)
- [x] Tests: parsers against real QEMU 11.1 output, name rules, menu entries; opt-in e2e on real QEMU covers stopped and running snapshots, duplicate and bad names, refusal to revert while running, and that a revert really restores the disk (data written after the snapshot is gone, checked with `qemu-io`)
- Found by experiment on QEMU 11.1: **full-state snapshots (`savevm`) do not work** here: `Device 'pflash1' is writable but does not support snapshots`. The UEFI variable store is a raw pflash file. So v1 is disk-only; the UEFI vars are not rolled back
- [~] Manual check in VS Code 2026-11-10: take (stopped and running), details card, delete, bad and duplicate names **work**. Revert-while-running and the data check inside a guest not done yet (blocked by the bug below)
- [x] **Bug found by that check, fixed:** a VM created without an ISO had no CD/DVD drive at all, so **Change ISO** (offered anyway) did nothing on a running VM and there was no drive to boot from after a restart. Every VM now gets a CD/DVD drive, empty without an ISO (`buildArgs`), on both architectures. Verified: unit tests, e2e (fails without the fix), and the empty `scsi-cd` insert and eject on real ARM64 under HVF. Existing VMs get the drive at their next start. Probably also the cause of the earlier Eject / Change ISO "needed a reload" report
- [ ] Full-state snapshots: needs the UEFI vars store in a snapshottable format (qcow2 pflash) and a check that `savevm`/`loadvm` work under HVF on Apple Silicon
- [ ] Snapshot size, and a snapshot tree/"current" marker (qcow2 does not track the current one)
- [ ] Clone / linked clone (`qemu-img create -b`, new MAC and name), `Capabilities.clone`
- [ ] Hyper-V (checkpoints) and Proxmox (snapshot API) map onto the same SDK: **not local**, write against docs + mocks
- [ ] Revert for a running VM without powering off (needs memory snapshots)

### Phase 13: `feat/remote-ssh-connect`  (Local: yes)

The VS Code-specific edge: work inside the VM from the editor.
- [ ] `VM: Open in Remote-SSH`: host and port from a port forward (QEMU user networking) or guest IP; user from a per-VM setting
- [ ] Offer to add an `~/.ssh/config` entry (shown before writing, never silent)
- [ ] Offer to add a public key to the guest (needs guest agent or cloud-init, see phase 14)
- [ ] `VM: Add SSH Port Forward` shortcut (uses the phase 5 forwards)
- [ ] Tests: ssh config rendering, host selection. Manual: arm64 Linux guest on the Mac, `ssh` over `hostfwd`

### Phase 14: `feat/provisioning`  (Local: yes)

- [ ] ISO / cloud image downloader: curated list (Ubuntu, Debian, Fedora, Alpine, arm64 and x86_64), checksum verified, progress, cached in a configured folder
- [ ] cloud-init seed ISO builder (user-data, meta-data: user, ssh key, hostname); create form option "cloud-init"
- [ ] Templates: save a VM as template, create from it (builds on phase 12 clone)
- [ ] Create form: "from cloud image" path that skips the installer
- [ ] Tests: seed ISO contents, checksum failure, resume. Manual: boot a cloud image on the Mac

### Phase 15: `feat/disk-management`  (Local: yes)

- [ ] Add / remove / resize disks (stopped VM; running via QMP `block_resize` where possible), `qemu-img convert` between formats
- [ ] Export / backup: qcow2 or raw copy, optional compression; import of OVA is out of scope for now
- [ ] Disk usage vs allocated shown in the details page
- [ ] Hyper-V (`Resize-VHD`, `New-VHD`) and Proxmox disk API: **not local**, mocks only

### Phase 16: `feat/guest-integration`  (Local: partly)

- [ ] Guest memory from the balloon driver or guest agent (`guest-get-memory-blocks`/`virtio-balloon` stats) so the memory chart shows guest usage, not host RSS
- [ ] Run command in guest and copy files host to guest and back through the guest agent (`guest-exec`, `guest-file-*`)
- [ ] Clipboard: bidirectional through the agent or SPICE agent; keyboard layout choice for **Type Clipboard Text** (US only today)
- [ ] Audio: `-audiodev coreaudio` on macOS, `pa`/`pipewire` on Linux, `dsound` on Windows, with a VM setting; no browser playback path yet (decide: host audio only)
- [ ] SPICE console (clipboard, resize, USB redirection): **check first** whether the QEMU build on the Mac has SPICE (Homebrew's usually does not); likely Linux only
- [ ] Shared folders: 9p/virtiofs work only with a Linux host (virtiofs) and are not available on macOS QEMU; SMB (`-netdev user,smb=`) needs Samba on the host. Do on Linux, document the Mac limit

### Phase 17: `feat/qemu-network-v2`  (Local: partly)

Finishes phase 5's deferred item.
- [ ] Multi-NIC definition; NIC editor (add / remove, model, MAC)
- [ ] Modes: user (done), vmnet-shared / vmnet-bridged on macOS (needs root or the `com.apple.vm.networking` entitlement, so test what works unprivileged; document the rest), bridge/tap on Linux (**not local**)
- [ ] Network throughput chart from `query-netstats` / tap counters where the backend has them (user networking has none)
- [ ] Guest IP fallback for bridged NICs: ARP table / DHCP lease lookup

### Phase 18: `feat/dev-ux`  (Local: yes)

- [ ] Shutdown countdown (phase 1 left it undone)
- [ ] State-change notifications (started, stopped, crashed) with a setting to silence
- [ ] Per-VM output channel: QEMU stderr, QMP events, provider actions
- [ ] Tree: favorites, tags, filter box, group by tag or state
- [ ] Public command API for other extensions and tasks (`vmm.api`: list, start, stop, getIp); `tasks.json` problem-free task type "vm"
- [ ] One-time "emulation is slow" notice (phase 10 leftover)
- [ ] Marketplace page: screenshots, GIFs, a short demo, Proxmox link in the provider table

### Phase 19: `feat/libvirt-provider`  (Local: partly)

One provider that covers most Linux KVM users.
- [ ] New `extensions/libvirt`: `qemu:///system`, `qemu:///session`, and `qemu+ssh://`; talk through `virsh` (no native binding) or the libvirt remote protocol
- [ ] Map domains, storage pools, networks, snapshots onto the SDK
- [ ] Local: Homebrew has `libvirt` with the QEMU driver, so `qemu:///session` on the Mac is a realistic target; confirm it runs HVF guests before promising it
- [ ] Remote hosts through `qemu+ssh://` can reuse the phase 9 SSH plumbing

### Phase 20: `feat/more-providers`  (Local: mostly no)

Order by demand; each is its own extension and its own release line.
- [ ] VMware: Fusion/Workstation via `vmrun` (**local on a Mac with Fusion**), ESXi/vSphere via REST (not local)
- [ ] VirtualBox via `VBoxManage` (VirtualBox for Apple Silicon exists, arm64 guests only; check before starting)
- [ ] Parallels via `prlctl` (needs a paid license on the Mac)
- [ ] XCP-ng, Nutanix: remote APIs only, mocks + a real server later
- [ ] Any new provider must pass the SDK conformance tests (add them first, using the fake provider as reference)

## What we can build and test on this Mac now

| Phase | Work | Why it works here |
|---|---|---|
| 11 | Manual passes, guest agent test, ARM64 OS install | Native HVF for arm64 guests |
| 12 | Snapshots, clones | `qemu-img` and QMP, qcow2 |
| 13 | Remote-SSH connect | Needs only `hostfwd` + an SSH-enabled Linux guest |
| 14 | Image downloader, cloud-init, templates | Pure host-side files, cloud images run on HVF |
| 15 | Disk add / resize / convert / export | `qemu-img` |
| 16 | Balloon / agent memory, guest exec, file copy, clipboard, audio | Guest agent already wired; `coreaudio` backend |
| 17 | Multi-NIC editor, vmnet (partly) | User mode works; vmnet may need privileges |
| 18 | UX items, notifications, logs, API | Extension-only |
| 9 | QEMU over SSH | Test against `localhost` with macOS Remote Login, or a second Linux VM |
| 19 | libvirt `qemu:///session` | Via Homebrew, verify first |

Cannot be validated on this Mac: Hyper-V (phase 8, parts of 2-4), VFIO/DDA (phase 7), Linux-only shared folders and bridges, Proxmox against a real cluster (Proxmox is x86 only; it could run nested under TCG but is slow), SPICE if the build lacks it.
Build order on the Mac: 11 → 12 → 13 → 14 → 9 → 19 (check Homebrew libvirt first) → 16 → 18 → 15 → 17.

## Log

Record merges here: `YYYY-MM-DD  phase N  branch  version  notes`.
