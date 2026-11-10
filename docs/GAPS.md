# Gap analysis: what is missing to be the best VM extension for VS Code

Snapshot of 2026-11-09, taken from the README and [ROADMAP.md](ROADMAP.md). Each gap maps to a roadmap phase.
Claims about other tools are from memory and were not re-checked.

## Biggest gaps

| # | Gap | Phase |
|---|-----|-------|
| 1 | Unverified code: Hyper-V, VFIO, DDA and Windows paths never ran on real hardware; many "manual check" boxes open; Proxmox status unclear | 11 |
| 2 | Remote hosts: Hyper-V over WinRM/SSH and QEMU over SSH are `todo` | 8, 9 |
| 3 | Missing hypervisors: libvirt/KVM, VMware, VirtualBox, Parallels, XCP-ng, Nutanix | 19, 20 |
| 4 | Snapshots, clones, templates: absent | 12, 14 |
| 5 | Networking: no NIC editor, no bridge/vmnet, no network chart, guest IP needs an agent | 17 |

## Dev-workflow gaps (the VS Code edge)

| # | Gap | Phase |
|---|-----|-------|
| 6 | Open the VM in Remote-SSH, ssh config entry, key injection | 13 |
| 7 | Provisioning: image downloader, cloud-init, template gallery | 14 |
| 8 | Run commands and copy files in the guest through the agent | 16 |
| 9 | Shared folders (virtiofs, 9p, SMB) | 16 |
| 10 | Real clipboard sync; keyboard layouts other than US | 16 |

## Console and UX polish

| # | Gap | Phase |
|---|-----|-------|
| 11 | SPICE (audio, USB redirection, clipboard, dynamic resize) | 16 |
| 12 | Audio | 16 |
| 13 | Disk management and export | 15 |
| 14 | Public API for other extensions, tasks, tags, favorites | 18 |
| 15 | Notifications, per-VM log, shutdown countdown | 18 |

## Quality and release hygiene

- Close the open manual checks; merge or close the stacked branches (phase 11).
- Memory chart shows host RSS, not guest memory (phase 16).
- CI e2e on real QEMU (macOS arm64, Linux KVM) and a Windows job (phase 11).
- Marketplace page: screenshots, GIFs, demo (phase 18).

## Order (highest value first)

| Rank | Phase | Item |
|---|---|---|
| 1 | 11 | Validate what exists |
| 2 | 12 | Snapshots, clones |
| 3 | 13 | Remote-SSH connect |
| 4 | 14 | Provisioning (images, cloud-init, templates) |
| 5 | 9 | QEMU over SSH |
| 6 | 19 | libvirt provider |
| 7 | 8 | Hyper-V remote |
| 8 | 16 | Guest integration (memory, exec/copy, clipboard, audio, SPICE, shared folders) |
| 9 | 18 | Dev UX (countdown, notifications, logs, API, tags) |
| 10 | 15 | Disk management |
| 11 | 17 | Network v2 |
| 12 | 20 | More providers |
