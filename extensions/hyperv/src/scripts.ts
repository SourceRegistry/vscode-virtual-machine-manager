/**
 * PowerShell scripts used by the Hyper-V provider. Every script receives its parameters as
 * `$p` (deserialized JSON) — never by string interpolation.
 */

export const HOST_INFO = String.raw`
$os = Get-CimInstance -ClassName Win32_OperatingSystem
$vmHost = Get-VMHost
[pscustomobject]@{
	Name = $env:COMPUTERNAME
	Cpus = [int]$vmHost.LogicalProcessorCount
	MemoryMB = [int64]($os.TotalVisibleMemorySize / 1KB)
	FreeMB = [int64]($os.FreePhysicalMemory / 1KB)
	Os = [string]$os.Caption
	OsVersion = [string]$os.Version
	CpuLoad = [double](Get-CimInstance -ClassName Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
	VhdPath = [string]$vmHost.VirtualHardDiskPath
}
`;

/**
 * Cmdlet versions of the reads the provider now does through CIM (`*_CIM` below). Not used by the provider: kept as the
 * reference `test/cim.e2e.test.ts` compares the CIM output with, field for field.
 */
export const LIST_VMS = String.raw`
Get-VM | ForEach-Object {
	$vm = $_
	[pscustomobject]@{
		Id = $vm.VMId.ToString()
		Name = $vm.Name
		State = $vm.State.ToString()
		Cpus = [int]$vm.ProcessorCount
		MemoryMB = [int64]($vm.MemoryAssigned / 1MB)
		StartupMB = [int64]($vm.MemoryStartup / 1MB)
		Uptime = [int64]$vm.Uptime.TotalSeconds
		Generation = [int]$vm.Generation
		Notes = [string]$vm.Notes
		Ips = @($vm.NetworkAdapters | ForEach-Object { $_.IPAddresses } | Where-Object { $_ })
		ComPort = [string]$vm.ComPort1.Path
		HasMedia = [bool](@(Get-VMDvdDrive -VM $vm | Where-Object { $_.Path }).Count)
	}
}
`;

/**
 * Reads through CIM (WMI, `root\virtualization\v2`) instead of the Hyper-V cmdlets. The cmdlets answer from a
 * cache that WMI events update about 4.5 s late, so a list or the settings right after a change show the old
 * value; CIM reads the current state. Each class is queried once for all machines and grouped by VM id, the
 * first GUID in an `InstanceID` (`Microsoft:<vm id>\...`); a checkpoint's settings carry the checkpoint's id
 * there, so they never mix into the machine's. Output matches the cmdlet scripts field for field.
 */
const CIM_COMMON = String.raw`
$ns = 'root\virtualization\v2'
$guid = '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}'
function VmOf([string]$instanceId) { if ($instanceId -match "^Microsoft:(?:GuestNetwork\\)?($guid)") { $Matches[1].ToUpperInvariant() } }
function GroupByVm($items) { $map = @{}; foreach ($i in $items) { $k = VmOf $i.InstanceID; if ($k) { if (-not $map.ContainsKey($k)) { $map[$k] = New-Object System.Collections.ArrayList }; [void]$map[$k].Add($i) } }; $map }
function First($map, $key) { if ($map.ContainsKey($key)) { $map[$key][0] } }
function All($map, $key) { if ($map.ContainsKey($key)) { @($map[$key]) } else { @() } }
function StateName([int]$s) {
	switch ($s) { 2 { 'Running' } 3 { 'Off' } 6 { 'Saved' } 10 { 'Starting' } 11 { 'Reset' } 32768 { 'Paused' } 32769 { 'Saved' } 32770 { 'Starting' } 32771 { 'Running' } 32773 { 'Saving' } 32774 { 'Stopping' } 32776 { 'Pausing' } 32777 { 'Resuming' } default { 'Other' } }
}
function MediaOf($sasd) { [string]@($sasd.HostResource)[0] }
$dvdDisk = 'Microsoft:Hyper-V:Virtual CD/DVD Disk'
$hardDisk = 'Microsoft:Hyper-V:Virtual Hard Disk'
`;

export const LIST_VMS_CIM = CIM_COMMON + String.raw`
$systems = @(Get-CimInstance -Namespace $ns -ClassName Msvm_ComputerSystem | Where-Object { $_.Name -match "^$guid$" })
if (-not $systems.Count) { return }
$vssd = @(Get-CimInstance -Namespace $ns -ClassName Msvm_VirtualSystemSettingData -Filter "VirtualSystemType='Microsoft:Hyper-V:System:Realized'")
$settings = @{}; foreach ($s in $vssd) { $settings[([string]$s.VirtualSystemIdentifier).ToUpperInvariant()] = $s }
$summary = @{}
if ($vssd.Count) {
	$svc = Get-CimInstance -Namespace $ns -ClassName Msvm_VirtualSystemManagementService
	# 0 Name (the VM id), 4 NumberOfProcessors, 100 EnabledState, 103 MemoryUsage (MB), 105 UpTime (ms)
	$r = Invoke-CimMethod -InputObject $svc -MethodName GetSummaryInformation -Arguments @{ SettingData = [CimInstance[]]$vssd; RequestedInformation = [uint32[]](0, 4, 100, 103, 105) }
	foreach ($i in $r.SummaryInformation) { $summary[([string]$i.Name).ToUpperInvariant()] = $i }
}
$memory = GroupByVm (Get-CimInstance -Namespace $ns -ClassName Msvm_MemorySettingData)
$disks = GroupByVm (Get-CimInstance -Namespace $ns -ClassName Msvm_StorageAllocationSettingData -Filter "ResourceSubType='$dvdDisk'")
$serial = GroupByVm (Get-CimInstance -Namespace $ns -ClassName Msvm_SerialPortSettingData)
$guest = GroupByVm (Get-CimInstance -Namespace $ns -ClassName Msvm_GuestNetworkAdapterConfiguration)
foreach ($cs in $systems) {
	$id = ([string]$cs.Name).ToUpperInvariant()
	$s = $settings[$id]
	$sum = $summary[$id]
	$com1 = All $serial $id | Where-Object { $_.InstanceID.EndsWith('\0') } | Select-Object -First 1
	[pscustomobject]@{
		Id = ([string]$cs.Name).ToLowerInvariant()
		Name = [string]$cs.ElementName
		State = StateName $cs.EnabledState
		Cpus = [int]$sum.NumberOfProcessors
		MemoryMB = [int64]$sum.MemoryUsage
		StartupMB = [int64](First $memory $id).VirtualQuantity
		Uptime = [int64]([int64]$sum.UpTime / 1000)
		Generation = if ([string]$s.VirtualSystemSubType -match 'SubType:(\d+)$') { [int]$Matches[1] } else { 1 }
		Notes = (@($s.Notes) -join [string][char]10)
		Ips = @(All $guest $id | ForEach-Object { $_.IPAddresses } | Where-Object { $_ })
		ComPort = [string]@($com1.Connection)[0]
		HasMedia = [bool](@(All $disks $id | Where-Object { MediaOf $_ }).Count)
	}
}
`;

/** Names of the Secure Boot templates Hyper-V ships, by id (`Msvm_VirtualSystemSettingData.SecureBootTemplateId`). */
const SECURE_BOOT_TEMPLATES = String.raw`
$templates = @{
	'1734C6E8-3154-4DDA-BA5F-A874CC483422' = 'MicrosoftWindows'
	'272E7447-90A4-4563-A4B9-8E4AB00526CE' = 'MicrosoftUEFICertificateAuthority'
	'4292AE2B-EE2C-42B5-A969-DD8F8689F6F3' = 'OpenSourceShieldedVM'
}
`;

export const GET_CONFIG_CIM = CIM_COMMON + SECURE_BOOT_TEMPLATES + String.raw`
$id = ([string]$p.id).ToUpperInvariant()
if ($id -notmatch "^$guid$") { throw 'Invalid virtual machine id' }
$cs = Get-CimInstance -Namespace $ns -ClassName Msvm_ComputerSystem -Filter "Name='$id'"
if (-not $cs) { throw 'Virtual machine not found' }
$s = Get-CimInstance -Namespace $ns -ClassName Msvm_VirtualSystemSettingData -Filter "VirtualSystemIdentifier='$id' AND VirtualSystemType='Microsoft:Hyper-V:System:Realized'"
# Every setting of the machine in one call (a query per class with LIKE scans all machines and is slower).
$parts = @(Get-CimAssociatedInstance -InputObject $s -Association Msvm_VirtualSystemSettingDataComponent)
function Parts([string]$class) { @($parts | Where-Object { $_.CimClass.CimClassName -eq $class }) }
$cpu = Parts 'Msvm_ProcessorSettingData' | Select-Object -First 1
$mem = Parts 'Msvm_MemorySettingData' | Select-Object -First 1
$storage = @(Parts 'Msvm_StorageAllocationSettingData' | Sort-Object InstanceID)
$com1 = Parts 'Msvm_SerialPortSettingData' | Where-Object { $_.InstanceID.EndsWith('\0') } | Select-Object -First 1
# The first adapter in WMI's own order is the one Get-VMNetworkAdapter lists first; its connection is "<adapter>\C".
$adapter = @(Parts 'Msvm_SyntheticEthernetPortSettingData') + @(Parts 'Msvm_EmulatedEthernetPortSettingData') | Select-Object -First 1
$port = if ($adapter) { Parts 'Msvm_EthernetPortAllocationSettingData' | Where-Object { $_.InstanceID -eq ($adapter.InstanceID + '\C') } | Select-Object -First 1 }
$switch = ''
if ($port -and $port.EnabledState -ne 3 -and (@($port.HostResource)[0] -match ',Name="([^"]+)"')) {
	$switch = [string](Get-CimInstance -Namespace $ns -ClassName Msvm_VirtualEthernetSwitch -Filter ("Name='" + $Matches[1] + "'")).ElementName
}
$generation = if ([string]$s.VirtualSystemSubType -match 'SubType:(\d+)$') { [int]$Matches[1] } else { 1 }
$secureBoot = $null
if ($generation -eq 2) {
	$secureBoot = if ($s.SecureBootEnabled) { $t = $templates[([string]$s.SecureBootTemplateId).ToUpperInvariant()]; if ($t) { $t } else { [string]$s.SecureBootTemplateId } } else { 'off' }
}
$comPort = [string]@($com1.Connection)[0]
[pscustomobject]@{
	Name = [string]$cs.ElementName
	State = StateName $cs.EnabledState
	Generation = $generation
	Cpus = [int]$cpu.VirtualQuantity
	MemoryMB = [int64]$mem.VirtualQuantity
	DynamicMemory = [bool]$mem.DynamicMemoryEnabled
	Switch = $switch
	Iso = MediaOf ($storage | Where-Object { $_.ResourceSubType -eq $dvdDisk } | Select-Object -First 1)
	SecureBoot = $secureBoot
	AutoStart = switch ([int]$s.AutomaticStartupAction) { 2 { 'Nothing' } 3 { 'StartIfRunning' } 4 { 'Start' } default { [string]$s.AutomaticStartupAction } }
	AutoStop = switch ([int]$s.AutomaticShutdownAction) { 2 { 'TurnOff' } 3 { 'Save' } 4 { 'ShutDown' } default { [string]$s.AutomaticShutdownAction } }
	CheckpointType = switch ([int]$s.UserSnapshotType) { 2 { 'Disabled' } 3 { 'Production' } 4 { 'ProductionOnly' } 5 { 'Standard' } default { [string]$s.UserSnapshotType } }
	Serial = [bool]$comPort
	ComPort = $comPort
	Notes = (@($s.Notes) -join [string][char]10)
	Disks = (@($storage | Where-Object { $_.ResourceSubType -eq $hardDisk } | ForEach-Object { MediaOf $_ }) -join '; ')
	Path = [string]$s.ConfigurationDataRoot
}
`;

/**
 * The machine's settings parts in one call, and its drives with the ids the cmdlets use:
 * `<ControllerType>:<ControllerNumber>:<ControllerLocation>`. A drive's InstanceID ends in
 * `\<controller number>\<location>\D` and its media (disk or ISO) has the same id ending in `\L`.
 */
const CIM_MACHINE = String.raw`
$id = ([string]$p.id).ToUpperInvariant()
if ($id -notmatch "^$guid$") { throw 'Invalid virtual machine id' }
$vssd = Get-CimInstance -Namespace $ns -ClassName Msvm_VirtualSystemSettingData -Filter "VirtualSystemIdentifier='$id' AND VirtualSystemType='Microsoft:Hyper-V:System:Realized'"
if (-not $vssd) { throw 'Virtual machine not found' }
$parts = @(Get-CimAssociatedInstance -InputObject $vssd -Association Msvm_VirtualSystemSettingDataComponent)
$byId = @{}; foreach ($x in $parts) { $byId[[string]$x.InstanceID] = $x }
function Drives([string]$subType) {
	@($parts | Where-Object { $_.ResourceSubType -eq $subType } | ForEach-Object {
		if ($_.InstanceID -match '^(.*)\\(\d+)\\(\d+)\\D$') {
			$base = $Matches[1]; $number = [int]$Matches[2]; $location = [int]$Matches[3]
			$controller = $byId[$base + '\' + $number]
			$type = if ([string]$controller.ResourceSubType -like '*IDE*') { 'IDE' } else { 'SCSI' }
			[pscustomobject]@{ Id = ('{0}:{1}:{2}' -f $type, $number, $location); Order = ('{0}{1:D4}{2:D4}' -f $type, $number, $location); Drive = $_; Media = $byId[$_.InstanceID.Substring(0, $_.InstanceID.Length - 1) + 'L'] }
		}
	} | Sort-Object Order)
}
`;

export const VM_DETAILS_CIM = CIM_COMMON + CIM_MACHINE + String.raw`
$disks = @()
foreach ($d in (Drives 'Microsoft:Hyper-V:Synthetic Disk Drive')) {
	$path = MediaOf $d.Media
	$size = $null; $format = $null
	if ($path) { try { $vhd = Get-VHD -Path $path -ErrorAction Stop; $size = [int64]$vhd.Size; $format = $vhd.VhdFormat.ToString() } catch { } }
	$disks += [pscustomobject]@{ Id = $d.Id; Kind = 'disk'; Path = $path; SizeBytes = $size; Format = $format }
}
foreach ($d in (Drives 'Microsoft:Hyper-V:Synthetic DVD Drive')) {
	$path = MediaOf $d.Media
	$size = $null
	if ($path -and (Test-Path -LiteralPath $path)) { $size = [int64](Get-Item -LiteralPath $path).Length }
	$disks += [pscustomobject]@{ Id = $d.Id; Kind = 'cdrom'; Path = $path; SizeBytes = $size; Format = 'iso' }
}
$switches = @{}; foreach ($sw in (Get-CimInstance -Namespace $ns -ClassName Msvm_VirtualEthernetSwitch)) { $switches[[string]$sw.Name] = [string]$sw.ElementName }
$guest = GroupByVm (Get-CimInstance -Namespace $ns -ClassName Msvm_GuestNetworkAdapterConfiguration -Filter "InstanceID LIKE 'Microsoft:GuestNetwork\\$id\\%'")
$adapters = @($parts | Where-Object { $_.CimClass.CimClassName -in 'Msvm_SyntheticEthernetPortSettingData', 'Msvm_EmulatedEthernetPortSettingData' })
$nics = @($adapters | ForEach-Object {
	$a = $_
	$port = $byId[$a.InstanceID + '\C']
	$connected = $port -and $port.EnabledState -ne 3 -and (@($port.HostResource)[0] -match ',Name="([^"]+)"')
	$switch = if ($connected) { $switches[$Matches[1]] } else { '' }
	$suffix = $a.InstanceID.Substring($a.InstanceID.IndexOf('\'))
	$config = All $guest $id | Where-Object { $_.InstanceID.EndsWith($suffix) } | Select-Object -First 1
	[pscustomobject]@{ Name = [string]$a.ElementName; Mac = [string]$a.Address; Switch = [string]$switch; Ips = @(@($config.IPAddresses) | Where-Object { $_ }); Connected = [bool]$connected; Legacy = ($a.CimClass.CimClassName -eq 'Msvm_EmulatedEthernetPortSettingData') }
})
[pscustomobject]@{ Generation = if ([string]$vssd.VirtualSystemSubType -match 'SubType:(\d+)$') { [int]$Matches[1] } else { 1 }; Disks = $disks; Nics = $nics }
`;

/**
 * Inserts, changes or ejects ($p.path empty) the ISO of a DVD drive through WMI. The cmdlet (Set-VMDvdDrive)
 * resolves the drive from its cache, which is still the old one a few seconds after a change, so an eject
 * followed by an insert failed with "object not found".
 */
export const SET_MEDIA_CIM = CIM_COMMON + CIM_MACHINE + String.raw`
function WaitFor($result, [string]$what) {
	if ($result.ReturnValue -eq 0) { return }
	if ($result.ReturnValue -ne 4096) { throw "$what failed (code $($result.ReturnValue))" }
	$job = $result.Job | Get-CimInstance
	while ($job.JobState -in 2, 3, 4) { Start-Sleep -Milliseconds 100; $job = $job | Get-CimInstance }
	if ($job.JobState -ne 7) { throw "$what failed: $($job.ErrorDescription)" }
}
function AsText($instance) {
	$serializer = [Microsoft.Management.Infrastructure.Serialization.CimSerializer]::Create()
	[Text.Encoding]::Unicode.GetString($serializer.Serialize($instance, [Microsoft.Management.Infrastructure.Serialization.InstanceSerializationOptions]::None))
}
$drive = Drives 'Microsoft:Hyper-V:Synthetic DVD Drive' | Where-Object { $_.Id -eq [string]$p.device } | Select-Object -First 1
if (-not $drive) { throw "DVD drive $($p.device) not found" }
$svc = Get-CimInstance -Namespace $ns -ClassName Msvm_VirtualSystemManagementService
$path = [string]$p.path
if (-not $path) {
	if ($drive.Media) { WaitFor (Invoke-CimMethod -InputObject $svc -MethodName RemoveResourceSettings -Arguments @{ ResourceSettings = [CimInstance[]]@($drive.Media) }) 'Eject' }
	return
}
if (-not (Test-Path -LiteralPath $path)) { throw "Image not found: $path" }
if ($drive.Media) {
	$media = $drive.Media
	$media.HostResource = [string[]]@($path)
	WaitFor (Invoke-CimMethod -InputObject $svc -MethodName ModifyResourceSettings -Arguments @{ ResourceSettings = [string[]]@(AsText $media) }) 'Changing the image'
	return
}
# A new media setting from the defaults of the host's DVD image pool, attached to the drive.
$pool = Get-CimInstance -Namespace $ns -ClassName Msvm_ResourcePool -Filter "ResourceSubType='$dvdDisk' AND Primordial=True"
$capabilities = Get-CimAssociatedInstance -InputObject $pool -ResultClassName Msvm_AllocationCapabilities
$media = (Get-CimAssociatedInstance -InputObject $capabilities -Association Msvm_SettingsDefineCapabilities | Where-Object { $_.InstanceID -like '*\Default' } | Select-Object -First 1).Clone()
$controllerPath = [string]$drive.Drive.Parent
$media.Parent = $controllerPath.Substring(0, $controllerPath.IndexOf('InstanceID="')) + 'InstanceID="' + $drive.Drive.InstanceID.Replace('\', '\\') + '"'
$media.HostResource = [string[]]@($path)
WaitFor (Invoke-CimMethod -InputObject $svc -MethodName AddResourceSettings -Arguments @{ AffectedConfiguration = $vssd; ResourceSettings = [string[]]@(AsText $media) }) 'Inserting the image'
`;

export const SNAPSHOT_LIST_CIM = String.raw`
$id = ([string]$p.id).ToUpperInvariant()
if ($id -notmatch '^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$') { throw 'Invalid virtual machine id' }
Get-CimInstance -Namespace 'root\virtualization\v2' -ClassName Msvm_VirtualSystemSettingData -Filter "VirtualSystemIdentifier='$id' AND VirtualSystemType='Microsoft:Hyper-V:Snapshot:Realized'" | ForEach-Object {
	[pscustomobject]@{
		Id = ([string]$_.ConfigurationID).ToLowerInvariant()
		Name = [string]$_.ElementName
		Created = [int64]([DateTimeOffset]$_.CreationTime).ToUnixTimeMilliseconds()
	}
}
`;

export const LIST_SWITCHES = String.raw`
Get-VMSwitch | ForEach-Object { [pscustomobject]@{ Name = $_.Name; Type = $_.SwitchType.ToString() } }
`;

export const POWER = String.raw`
$vm = Get-VM -Id $p.id
switch ($p.action) {
	'start' {
		if ($vm.Notes.StartsWith('[vmm:template]')) { throw 'This is a template. Create a machine from it instead of starting it.' }
		Start-VM -VM $vm
	}
	'shutdown' { Stop-VM -VM $vm -Force }
	'stop' { Stop-VM -VM $vm -TurnOff -Force }
	'reboot' {
		if ((Get-Command Restart-VM).Parameters.ContainsKey('Type')) { Restart-VM -VM $vm -Type Reboot -Force }
		else { Stop-VM -VM $vm -Force; Start-VM -VM $vm }
	}
	'reset' { Restart-VM -VM $vm -Force }
	default { throw "Unsupported action: $($p.action)" }
}
`;

export const CREATE_VM = String.raw`
$generation = [int]$p.generation
if (Get-VM -Name $p.name -ErrorAction SilentlyContinue) { throw "A virtual machine named '$($p.name)' already exists" }
$vhdDir = if ($p.vhdDirectory) { [string]$p.vhdDirectory } else { (Get-VMHost).VirtualHardDiskPath }
$vhd = Join-Path $vhdDir ($p.name + '.vhdx')
if (Test-Path -LiteralPath $vhd) { throw "The disk '$vhd' already exists" }
$new = @{
	Name = [string]$p.name
	Generation = $generation
	MemoryStartupBytes = ([int64]$p.memoryMB * 1MB)
	NewVHDPath = $vhd
	NewVHDSizeBytes = ([int64]$p.diskGB * 1GB)
}
if ($p.switch) { $new.SwitchName = [string]$p.switch }
$vm = New-VM @new
Set-VMProcessor -VM $vm -Count ([int]$p.cpus)
Set-VMMemory -VM $vm -DynamicMemoryEnabled ([bool]$p.dynamicMemory)
if ($p.iso) {
	if ($generation -eq 2) {
		$dvd = Add-VMDvdDrive -VM $vm -Path ([string]$p.iso) -Passthru
		Set-VMFirmware -VM $vm -FirstBootDevice $dvd
	} else {
		Set-VMDvdDrive -VMName $vm.Name -ControllerNumber 1 -ControllerLocation 0 -Path ([string]$p.iso)
	}
}
if ($generation -eq 2) {
	if ($p.secureBoot -eq 'off') { Set-VMFirmware -VM $vm -EnableSecureBoot Off }
	elseif ($p.secureBoot) { Set-VMFirmware -VM $vm -EnableSecureBoot On -SecureBootTemplate ([string]$p.secureBoot) }
}
if ($p.serial) { Set-VMComPort -VM $vm -Number 1 -Path ('\\.\pipe\vmm-' + $vm.VMId.ToString()) }
if ($p.notes) { Set-VM -VM $vm -Notes ([string]$p.notes) }
[pscustomobject]@{ Id = $vm.VMId.ToString(); Name = $vm.Name }
`;

export const GET_CONFIG = String.raw`
$vm = Get-VM -Id $p.id
$adapter = @(Get-VMNetworkAdapter -VM $vm)[0]
$dvd = @(Get-VMDvdDrive -VM $vm)[0]
$fw = if ($vm.Generation -eq 2) { Get-VMFirmware -VM $vm } else { $null }
$secureBoot = $null
if ($fw) { $secureBoot = if ($fw.SecureBoot.ToString() -eq 'On') { [string]$fw.SecureBootTemplate } else { 'off' } }
[pscustomobject]@{
	Name = $vm.Name
	State = $vm.State.ToString()
	Generation = [int]$vm.Generation
	Cpus = [int]$vm.ProcessorCount
	MemoryMB = [int64]($vm.MemoryStartup / 1MB)
	DynamicMemory = [bool]$vm.DynamicMemoryEnabled
	Switch = [string]$adapter.SwitchName
	Iso = [string]$dvd.Path
	SecureBoot = $secureBoot
	AutoStart = $vm.AutomaticStartAction.ToString()
	AutoStop = $vm.AutomaticStopAction.ToString()
	CheckpointType = $vm.CheckpointType.ToString()
	Serial = [bool]$vm.ComPort1.Path
	ComPort = [string]$vm.ComPort1.Path
	Notes = [string]$vm.Notes
	Disks = (@(Get-VMHardDiskDrive -VM $vm | ForEach-Object { $_.Path }) -join '; ')
	Path = [string]$vm.Path
}
`;

export const UPDATE_VM = String.raw`
$vm = Get-VM -Id $p.id
$v = $p.values
if ($v.name -and $v.name -ne $vm.Name) { Rename-VM -VM $vm -NewName ([string]$v.name); $vm = Get-VM -Id $p.id }
if ($null -ne $v.cpus -and [int]$v.cpus -ne $vm.ProcessorCount) { Set-VMProcessor -VM $vm -Count ([int]$v.cpus) }
if ($null -ne $v.dynamicMemory -and [bool]$v.dynamicMemory -ne $vm.DynamicMemoryEnabled) { Set-VMMemory -VM $vm -DynamicMemoryEnabled ([bool]$v.dynamicMemory) }
if ($null -ne $v.memoryMB -and ([int64]$v.memoryMB * 1MB) -ne $vm.MemoryStartup) { Set-VMMemory -VM $vm -StartupBytes ([int64]$v.memoryMB * 1MB) }
$adapter = @(Get-VMNetworkAdapter -VM $vm)[0]
if ($adapter) {
	if ($v.switch) { if ($adapter.SwitchName -ne $v.switch) { Connect-VMNetworkAdapter -VMNetworkAdapter $adapter -SwitchName ([string]$v.switch) } }
	elseif ($adapter.SwitchName) { Disconnect-VMNetworkAdapter -VMNetworkAdapter $adapter }
}
$dvd = @(Get-VMDvdDrive -VM $vm)[0]
if ($v.iso) {
	if ($dvd) { if ($dvd.Path -ne $v.iso) { Set-VMDvdDrive -VMDvdDrive $dvd -Path ([string]$v.iso) } }
	else { Add-VMDvdDrive -VM $vm -Path ([string]$v.iso) }
} elseif ($dvd -and $dvd.Path) { Set-VMDvdDrive -VMDvdDrive $dvd -Path $null }
if ($vm.Generation -eq 2 -and $v.secureBoot) {
	$fw = Get-VMFirmware -VM $vm
	$current = if ($fw.SecureBoot.ToString() -eq 'On') { [string]$fw.SecureBootTemplate } else { 'off' }
	if ($current -ne $v.secureBoot) {
		if ($v.secureBoot -eq 'off') { Set-VMFirmware -VM $vm -EnableSecureBoot Off }
		else { Set-VMFirmware -VM $vm -EnableSecureBoot On -SecureBootTemplate ([string]$v.secureBoot) }
	}
}
if ($v.autoStart -and $v.autoStart -ne $vm.AutomaticStartAction.ToString()) { Set-VM -VM $vm -AutomaticStartAction ([string]$v.autoStart) }
if ($v.autoStop -and $v.autoStop -ne $vm.AutomaticStopAction.ToString()) { Set-VM -VM $vm -AutomaticStopAction ([string]$v.autoStop) }
if ($v.checkpointType -and $v.checkpointType -ne $vm.CheckpointType.ToString()) { Set-VM -VM $vm -CheckpointType ([string]$v.checkpointType) }
if ([string]$v.notes -ne [string]$vm.Notes) { Set-VM -VM $vm -Notes ([string]$v.notes) }
if ($null -ne $v.serial) {
	$hasPipe = [bool]$vm.ComPort1.Path
	if ([bool]$v.serial -and -not $hasPipe) { Set-VMComPort -VM $vm -Number 1 -Path ('\\.\pipe\vmm-' + $vm.VMId.ToString()) }
	elseif (-not [bool]$v.serial -and $hasPipe) { Set-VMComPort -VM $vm -Number 1 -Path '' }
}
`;

/**
 * With checkpoints the VM runs on a differencing disk (.avhdx) whose parents lead back to the disk it was made
 * with, and each checkpoint branch has its own. Deleting the disks walks up from every one of them through the
 * .avhdx files to the first ordinary disk and stops there: a parent of that (a shared base image) is never deleted.
 * A clone's own folder under the VM storage path (see CLONE_VM) is removed when nothing but empty folders is left.
 */
export const DELETE_VM = String.raw`
$vm = Get-VM -Id $p.id
$disks = @()
if ($p.deleteDisks) {
	$leaves = @(Get-VMHardDiskDrive -VM $vm | ForEach-Object { $_.Path })
	$leaves += @(Get-VMSnapshot -VM $vm | ForEach-Object { Get-VMHardDiskDrive -VMSnapshot $_ } | ForEach-Object { $_.Path })
	foreach ($leaf in $leaves) {
		$current = [string]$leaf
		while ($current) {
			if ($disks -notcontains $current) { $disks += $current }
			if (-not $current.EndsWith('.avhdx', [StringComparison]::OrdinalIgnoreCase)) { break }
			$parent = $null
			try { $parent = [string](Get-VHD -Path $current -ErrorAction Stop).ParentPath } catch { }
			$current = $parent
		}
	}
}
$folder = [string]$vm.Path
if ($vm.State.ToString() -ne 'Off') { Stop-VM -VM $vm -TurnOff -Force }
Remove-VM -VM $vm -Force
if ($p.deleteDisks) {
	foreach ($disk in $disks) { if ($disk -and (Test-Path -LiteralPath $disk)) { Remove-Item -LiteralPath $disk -Force } }
	$storage = [string](Get-VMHost).VirtualHardDiskPath
	if ($folder -and $storage -and ((Split-Path -Parent $folder).TrimEnd('\') -eq $storage.TrimEnd('\')) -and (Test-Path -LiteralPath $folder) -and -not (Get-ChildItem -LiteralPath $folder -Recurse -File -Force)) {
		Remove-Item -LiteralPath $folder -Recurse -Force
	}
}
`;

/** Thumbnail of the VM screen as RGB565, cached CIM objects in the session for speed. */
export const THUMBNAIL = String.raw`
$ns = 'root\virtualization\v2'
if (-not $global:vmmThumb -or $global:vmmThumb.Id -ne $p.id) {
	$cs = Get-CimInstance -Namespace $ns -ClassName Msvm_ComputerSystem -Filter ("Name='" + $p.id + "'")
	if (-not $cs) { throw 'Virtual machine not found' }
	$vssd = Get-CimAssociatedInstance -InputObject $cs -ResultClassName Msvm_VirtualSystemSettingData |
		Where-Object { $_.VirtualSystemType -eq 'Microsoft:Hyper-V:System:Realized' } | Select-Object -First 1
	$svc = Get-CimInstance -Namespace $ns -ClassName Msvm_VirtualSystemManagementService
	$global:vmmThumb = @{ Id = $p.id; Cs = $cs; Vssd = $vssd; Svc = $svc }
}
$cs = Get-CimInstance -Namespace $ns -ClassName Msvm_ComputerSystem -Filter ("Name='" + $p.id + "'")
if ($cs.EnabledState -ne 2) { throw 'The virtual machine is not running' }
$w = 1024; $h = 768
$head = Get-CimAssociatedInstance -InputObject $cs -ResultClassName Msvm_VideoHead | Select-Object -First 1
if ($head -and $head.CurrentHorizontalResolution) { $w = [int]$head.CurrentHorizontalResolution; $h = [int]$head.CurrentVerticalResolution }
$max = [int]$p.maxWidth
if ($w -gt $max) { $h = [int]([math]::Round($h * $max / $w)); $w = $max }
$r = Invoke-CimMethod -InputObject $global:vmmThumb.Svc -MethodName GetVirtualSystemThumbnailImage -Arguments @{
	TargetSystem = $global:vmmThumb.Vssd; WidthPixels = [uint16]$w; HeightPixels = [uint16]$h
}
if ($r.ReturnValue -ne 0 -or -not $r.ImageData) { throw "Could not capture the screen (code $($r.ReturnValue))" }
[pscustomobject]@{ Width = $w; Height = $h; Data = [Convert]::ToBase64String([byte[]]$r.ImageData) }
`;

/**
 * Who the console sign-in is for. Microsoft accounts authenticate over the network as
 * `MicrosoftAccount\<e-mail>`; the device may also be set to Windows Hello only (passwordless).
 */
export const CONSOLE_ACCOUNT = String.raw`
$user = Get-LocalUser -Name $env:USERNAME -ErrorAction SilentlyContinue
$msa = $null
if ($user -and [string]$user.PrincipalSource -eq 'MicrosoftAccount') {
	$msa = (Get-ChildItem 'HKCU:\Software\Microsoft\IdentityCRL\UserExtendedProperties' -ErrorAction SilentlyContinue | Select-Object -First 1).PSChildName
}
$passwordless = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\PasswordLess\Device' -ErrorAction SilentlyContinue).DevicePasswordLessBuildVersion
[pscustomobject]@{
	User = [string]$env:USERNAME
	Domain = [string]$env:USERDOMAIN
	MicrosoftAccount = [string]$msa
	Passwordless = [bool]($passwordless -eq 2)
}
`;

export const PREREQUISITES = String.raw`
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$hyperVAdmins = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-578')
$service = Get-Service -Name vmms -ErrorAction SilentlyContinue
[pscustomobject]@{
	Module = [bool](Get-Module -ListAvailable -Name Hyper-V)
	Service = if ($service) { $service.Status.ToString() } else { 'Missing' }
	IsAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
	IsHyperVAdmin = $principal.IsInRole($hyperVAdmins)
	User = $identity.Name
}
`;

export const VM_DETAILS = String.raw`
$vm = Get-VM -Id $p.id
$disks = @()
foreach ($d in (Get-VMHardDiskDrive -VM $vm)) {
	$size = $null; $format = $null
	if ($d.Path) {
		try { $vhd = Get-VHD -Path $d.Path -ErrorAction Stop; $size = [int64]$vhd.Size; $format = $vhd.VhdFormat.ToString() } catch { }
	}
	$disks += [pscustomobject]@{ Id = ('{0}:{1}:{2}' -f $d.ControllerType, $d.ControllerNumber, $d.ControllerLocation); Kind = 'disk'; Path = [string]$d.Path; SizeBytes = $size; Format = $format }
}
foreach ($d in (Get-VMDvdDrive -VM $vm)) {
	$size = $null
	if ($d.Path -and (Test-Path -LiteralPath $d.Path)) { $size = [int64](Get-Item -LiteralPath $d.Path).Length }
	$disks += [pscustomobject]@{ Id = ('{0}:{1}:{2}' -f $d.ControllerType, $d.ControllerNumber, $d.ControllerLocation); Kind = 'cdrom'; Path = [string]$d.Path; SizeBytes = $size; Format = 'iso' }
}
$nics = @(Get-VMNetworkAdapter -VM $vm | ForEach-Object {
	[pscustomobject]@{ Name = $_.Name; Mac = [string]$_.MacAddress; Switch = [string]$_.SwitchName; Ips = @($_.IPAddresses | Where-Object { $_ }); Connected = [bool]$_.Connected; Legacy = [bool]$_.IsLegacy }
})
[pscustomobject]@{ Generation = [int]$vm.Generation; Disks = $disks; Nics = $nics }
`;

export const VM_STATS = String.raw`
$vm = Get-VM -Id $p.id
[pscustomobject]@{
	CpuPercent = [int]$vm.CPUUsage
	AssignedMB = [int64]($vm.MemoryAssigned / 1MB)
	DemandMB = [int64]($vm.MemoryDemand / 1MB)
	StartupMB = [int64]($vm.MemoryStartup / 1MB)
}
`;

/** Capability detection and the PCI devices that could be assigned. */
export const DDA_LIST = String.raw`
$vm = Get-VM -Id $p.id
$isServer = ((Get-CimInstance -ClassName Win32_OperatingSystem).ProductType -ne 1)
$hasCmdlets = [bool](Get-Command Add-VMAssignableDevice -ErrorAction SilentlyContinue)
$devices = @()
if ($isServer -and $hasCmdlets) {
	$assigned = @(Get-VMAssignableDevice -VM $vm | ForEach-Object { $_.LocationPath })
	$dismounted = @(Get-VMHostAssignableDevice | ForEach-Object { $_.LocationPath })
	$devices = @(Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -like 'PCI\*' } | ForEach-Object {
		$path = (Get-PnpDeviceProperty -InstanceId $_.InstanceId -KeyName 'DEVPKEY_Device_LocationPaths' -ErrorAction SilentlyContinue).Data | Where-Object { $_ -like 'PCIROOT*' } | Select-Object -First 1
		if ($path) {
			[pscustomobject]@{
				LocationPath = [string]$path
				Name = [string]$_.FriendlyName
				Class = [string]$_.Class
				InstanceId = [string]$_.InstanceId
				Assigned = [bool]($assigned -contains $path)
				Dismounted = [bool]($dismounted -contains $path)
			}
		}
	})
}
[pscustomobject]@{ IsServer = $isServer; HasCmdlets = $hasCmdlets; Devices = $devices }
`;

export const DDA_ATTACH = String.raw`
$vm = Get-VM -Id $p.id
if ($vm.State -ne 'Off') { throw "Turn $($vm.Name) off first: devices are assigned to a stopped VM." }
Set-VM -VM $vm -AutomaticStopAction TurnOff -GuestControlledCacheTypes $true -LowMemoryMappedIoSpace 3Gb -HighMemoryMappedIoSpace 33280Mb
Dismount-VMHostAssignableDevice -Force -LocationPath $p.path
Add-VMAssignableDevice -LocationPath $p.path -VM $vm
`;

export const DDA_DETACH = String.raw`
$vm = Get-VM -Id $p.id
if ($vm.State -ne 'Off') { throw "Turn $($vm.Name) off first." }
Remove-VMAssignableDevice -LocationPath $p.path -VM $vm
Mount-VMHostAssignableDevice -LocationPath $p.path
`;

export const VM_NAME = String.raw`
[pscustomobject]@{ Name = (Get-VM -Id $p.id).Name }
`;

export const SNAPSHOT_LIST = String.raw`
Get-VMSnapshot -VM (Get-VM -Id $p.id) | ForEach-Object {
	[pscustomobject]@{
		Id = $_.Id.ToString()
		Name = [string]$_.Name
		Created = [int64]([DateTimeOffset]$_.CreationTime).ToUnixTimeMilliseconds()
	}
}
`;

/**
 * The Hyper-V module answers from a cache that WMI events update a few seconds late (about 4.5 s, measured on
 * Windows 11): `Get-VMSnapshot` right after `Checkpoint-VM` does not list the new checkpoint yet, even in the same
 * process. So the new checkpoint comes from `-Passthru`, and a lookup by id waits briefly for it to show up.
 */
export const SNAPSHOT_CREATE = String.raw`
$vm = Get-VM -Id $p.id
# Names from CIM, which has no cache, so a checkpoint made a moment ago counts too.
$taken = Get-CimInstance -Namespace 'root\virtualization\v2' -ClassName Msvm_VirtualSystemSettingData -Filter ("VirtualSystemIdentifier='" + $vm.VMId.ToString() + "' AND VirtualSystemType='Microsoft:Hyper-V:Snapshot:Realized'") |
	Where-Object { $_.ElementName -eq [string]$p.name }
if ($taken) { throw "A snapshot named '$($p.name)' already exists" }
$s = Checkpoint-VM -VM $vm -SnapshotName ([string]$p.name) -Passthru | Select-Object -Last 1
if (-not $s) { throw 'Hyper-V did not create the checkpoint' }
[pscustomobject]@{
	Id = $s.Id.ToString()
	Name = [string]$s.Name
	Created = [int64]([DateTimeOffset]$s.CreationTime).ToUnixTimeMilliseconds()
}
`;

const SNAPSHOT_BY_ID = String.raw`
$vm = Get-VM -Id $p.id
$s = $null
for ($i = 0; $i -lt 20 -and -not $s; $i++) {
	if ($i) { Start-Sleep -Milliseconds 500 }
	$s = Get-VMSnapshot -VM $vm | Where-Object { $_.Id.ToString() -eq $p.snapshot } | Select-Object -First 1
}
if (-not $s) { throw 'The snapshot no longer exists' }
`;

export const SNAPSHOT_RESTORE = SNAPSHOT_BY_ID + String.raw`
Restore-VMSnapshot -VMSnapshot $s -Confirm:$false
`;

export const SNAPSHOT_DELETE = SNAPSHOT_BY_ID + String.raw`
Remove-VMSnapshot -VMSnapshot $s -Confirm:$false
`;

/**
 * Copy through Export-VM / Import-VM: the copy gets a new id and its own disks in a folder of its own, so
 * nothing is shared with the original. The export is a temporary folder next to the VM storage.
 */
export const CLONE_VM = String.raw`
$source = Get-VM -Id $p.id
if (Get-VM -Name $p.name -ErrorAction SilentlyContinue) { throw "A virtual machine named '$($p.name)' already exists" }
$base = (Get-VMHost).VirtualHardDiskPath
$tag = [guid]::NewGuid().ToString('N').Substring(0, 8)
$export = Join-Path $base ('.vmm-export-' + $tag)
$target = Join-Path $base ([string]$p.name + '-' + $tag)
try {
	Export-VM -VM $source -Path $export
	$config = Get-ChildItem -LiteralPath (Join-Path (Join-Path $export $source.Name) 'Virtual Machines') -Filter '*.vmcx' | Select-Object -First 1
	if (-not $config) { throw 'The export did not produce a configuration file' }
	$copy = Import-VM -Path $config.FullName -Copy -GenerateNewId -VirtualMachinePath $target -VhdDestinationPath (Join-Path $target 'Virtual Hard Disks') -SnapshotFilePath (Join-Path $target 'Snapshots') -SmartPagingFilePath $target
	Rename-VM -VM $copy -NewName ([string]$p.name)
	# A copy of a template is a normal machine; the clone keeps no snapshots of the original.
	if ($copy.Notes.StartsWith('[vmm:template]')) { Set-VM -VM $copy -Notes ($copy.Notes.Substring(14).TrimStart(@([char]13, [char]10))) }
	Get-VMSnapshot -VM $copy | Remove-VMSnapshot -Confirm:$false
	[pscustomobject]@{ Id = $copy.VMId.ToString(); Name = [string]$copy.Name }
} finally {
	if (Test-Path -LiteralPath $export) { Remove-Item -LiteralPath $export -Recurse -Force -ErrorAction SilentlyContinue }
}
`;

export const SET_NOTES_TEMPLATE = String.raw`
$vm = Get-VM -Id $p.id
if ($vm.State.ToString() -ne 'Off') { throw 'Shut the virtual machine down before turning it into a template' }
Set-VM -VM $vm -Notes ([string]$p.notes)
`;
