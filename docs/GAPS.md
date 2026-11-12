# Gap analysis: what is missing to be the best VM extension for VS Code

First taken 2026-11-09, status updated 2026-11-12, from the README and [ROADMAP.md](ROADMAP.md). Each gap maps to a roadmap phase.
Claims about other tools are from memory and were not re-checked.

## Biggest gaps

| # | Gap | Phase | Status 2026-11-12 |
|---|-----|-------|---|
| 1 | Unverified code: Hyper-V, VFIO, DDA and Windows paths never ran on real hardware; many "manual check" boxes open; Proxmox status unclear | 11 | Open. Proxmox status is written down (mocked API only); Hyper-V, VFIO, DDA still need hardware |
| 2 | Remote hosts: Hyper-V over WinRM/SSH and QEMU over SSH are `todo` | 8, 9 | QEMU over SSH done (9); Hyper-V remote open (8) |
| 3 | Missing hypervisors: libvirt/KVM, VMware, VirtualBox, Parallels, XCP-ng, Nutanix | 19, 20 | libvirt done (19, edit / clone / pools / networks open); the rest open (20) |
| 4 | Snapshots, clones, templates: absent | 12, 14 | Done for QEMU, Hyper-V (untested), Proxmox; libvirt has snapshots, no clone or templates |
| 5 | Networking: no NIC editor, no bridge/vmnet, no network chart, guest IP needs an agent | 17 | Open |

## Dev-workflow gaps (the VS Code edge)

| # | Gap | Phase | Status 2026-11-12 |
|---|-----|-------|---|
| 6 | Open the VM in Remote-SSH, ssh config entry, key injection | 13 | Done, except key injection into an existing machine |
| 7 | Provisioning: image downloader, cloud-init, template gallery | 14 | Cloud images and templates done (QEMU, libvirt); installer ISO downloads open |
| 8 | Run commands and copy files in the guest through the agent | 16 | Done (QEMU, libvirt); libvirt copies to the guest are slow (~80 KB/s) |
| 9 | Shared folders (virtiofs, 9p, SMB) | 16 | Open |
| 10 | Real clipboard sync; keyboard layouts other than US | 16 | Open |

## Console and UX polish

| # | Gap | Phase | Status 2026-11-12 |
|---|-----|-------|---|
| 11 | SPICE (audio, USB redirection, clipboard, dynamic resize) | 16 | Open |
| 12 | Audio | 16 | Open |
| 13 | Disk management and export | 15 | Open |
| 14 | Public API for other extensions, tasks, tags, favorites | 18 | Open |
| 15 | Notifications, per-VM log, shutdown countdown | 18 | Open |
| 16 | AI agents cannot see or drive VMs (language model tools / MCP) | 21 | Open |

## Quality and release hygiene

- Close the open manual checks (phase 11). The stacked branches were merged with PR #1 (2026-11-05).
- ~~Memory chart shows host RSS, not guest memory (phase 16).~~ Done 2026-11-12: guest memory from the balloon driver, and the chart says which source it shows.
- CI e2e on real QEMU (macOS arm64, Linux) runs on every pull request and passes, but is still non-blocking; a Windows job is still missing (phase 11).
- Marketplace page: screenshots, GIFs, demo (phase 18).

## Order (highest value first)

| Rank | Phase | Item | Status 2026-11-12 |
|---|---|---|---|
| 1 | 11 | Validate what exists | In progress |
| 2 | 12 | Snapshots, clones | Merged |
| 3 | 13 | Remote-SSH connect | Merged |
| 4 | 14 | Provisioning (images, cloud-init, templates) | Merged |
| 5 | 9 | QEMU over SSH | Merged |
| 6 | 19 | libvirt provider | Mostly merged |
| 7 | 8 | Hyper-V remote | Open (no Windows host) |
| 8 | 16 | Guest integration (memory, exec/copy, clipboard, audio, SPICE, shared folders) | Memory, exec, copy merged |
| 9 | 18 | Dev UX (countdown, notifications, logs, API, tags) | Next |
| 10 | 15 | Disk management | Open |
| 11 | 17 | Network v2 | Open |
| 12 | 20 | More providers | Open |
| 13 | 21 | MCP / language model tools | Open |
