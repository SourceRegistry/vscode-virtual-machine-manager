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
	VhdPath = [string]$vmHost.VirtualHardDiskPath
}
`;

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
	}
}
`;

export const LIST_SWITCHES = String.raw`
Get-VMSwitch | ForEach-Object { [pscustomobject]@{ Name = $_.Name; Type = $_.SwitchType.ToString() } }
`;

export const POWER = String.raw`
$vm = Get-VM -Id $p.id
switch ($p.action) {
	'start' { Start-VM -VM $vm }
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

export const DELETE_VM = String.raw`
$vm = Get-VM -Id $p.id
$disks = @(Get-VMHardDiskDrive -VM $vm | ForEach-Object { $_.Path })
if ($vm.State.ToString() -ne 'Off') { Stop-VM -VM $vm -TurnOff -Force }
Remove-VM -VM $vm -Force
if ($p.deleteDisks) {
	foreach ($disk in $disks) { if ($disk -and (Test-Path -LiteralPath $disk)) { Remove-Item -LiteralPath $disk -Force } }
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
