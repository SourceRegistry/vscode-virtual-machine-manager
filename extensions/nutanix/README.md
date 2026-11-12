# VM Manager – Nutanix

Nutanix AHV provider for [VM Manager](https://marketplace.visualstudio.com/items?itemName=sourceregistry.vm-manager), using the Prism Central v3 REST API.

Add a cluster of type **Nutanix**, enter the Prism Central address (for example `https://prism.example.com:9440`) and a Prism user name (`admin`, or a directory user such as `alice@example.com`). A Prism Element address works too, for that one cluster. TLS verification is on by default; the connection form allows turning it off for a trusted server with a self-signed certificate.

**Sign in with** a user name and password, or a Prism Central API key (Prism Central 2024.3 and later, created for a service account under Admin Center → IAM). The API key is kept in the OS keychain.

**Password:** by default you are asked for it at the first sign-in after VS Code starts. It is then kept in memory only, until VS Code closes or you choose **Sign Out**. Turn on **Remember password** to keep it in the OS keychain (VS Code SecretStorage) instead. A rejected password is never retried, so a typo does not lock the account. A password is sent as basic authentication over HTTPS, an API key in the `X-ntnx-api-key` header; Prism's session cookie is reused while the connection is open.

Each Prism Element cluster that Prism Central manages is shown as a node; Prism Central itself is left out.

Supported:

- Discover clusters (AOS version, hypervisor, hosts, CPU cores and memory) and their VMs with power state, vCPUs, memory, IP and MAC addresses.
- Create VMs: vCPUs, memory, a subnet of the cluster (VLAN or VPC), a system disk that is either empty or cloned from a disk image (grown to the disk size you choose), a CD-ROM with an ISO image, optional cloud-init user data, and start after creation.
- Edit the name, vCPUs, cores per vCPU, memory and description. Prism decides which changes a running VM accepts (memory and CPU can usually only grow while it runs).
- Start, shut down (ACPI), reboot (ACPI), power off and reset, waiting for the Prism task to finish. On a Prism Central without the power endpoints, shutdown falls back to an ACPI power-off through the VM spec.
- Hardware inventory: disks with their storage container or source image, CD-ROM drives, NICs with subnet and addresses, GPUs and serial ports.
- CPU and memory usage in the VM dashboard (from Prism's `groups` statistics; guest memory where Prism has it, otherwise host memory).
- Recovery points as snapshots: create (crash consistent), list, revert (with the VM powered off) and delete.
- Clone a VM under a new name.
- The VM's display console inside VS Code, through Prism's VNC proxy, and opening Prism in the browser.
- Delete VMs with their disks. Disk-preserving deletion is rejected.

The signed-in user needs the Prism roles for the operations you use: viewing VMs, clusters, hosts, subnets and images; VM power, create, update, delete and clone; recovery points; and VM console access.

**Status:** the provider is covered by unit tests against a fake Prism API (inventory, create, edit, power, recovery points, clones, statistics, sign-in) and a local websocket server (console). It has not been run against a live Prism Central yet; `test/live.e2e.test.ts` is an opt-in, read-only check against one (see the comment at its top). Whether Prism Central accepts API keys on the v3 API is part of what that check has to show. The console uses the same VNC proxy as the Prism web console, which Nutanix does not document as a public API: treat it as experimental and report what you find.

Not included: VM templates (Prism Central v4 API), migration, disk and NIC editing, CD-ROM media changes after creation, image upload, and categories and projects.

### Trying it without a Nutanix cluster

`node extensions/nutanix/scripts/fake-prism.mjs` (from the repository root) starts a fake Prism Central on `https://localhost:9440` with one AHV cluster, a few VMs, subnets and images. Sign in as `admin` / `nutanix/4u` (or start it with `--api-key <key>`), and untick **Verify TLS certificate**: it uses a self-signed test certificate. Changes run as short tasks, statistics move, recovery points and clones work, and the console shows a small test picture. A VM with "win" in its name ignores ACPI shutdown, to try the Power Off prompt. `test/fakePrism.test.ts` runs the provider against it in CI. It follows the v3 swagger, not a real Prism: it shows the extension works, not that Prism agrees.

Build from the repository root with `node esbuild.mjs --only nutanix`. Package with `node scripts/package.mjs nutanix`.
