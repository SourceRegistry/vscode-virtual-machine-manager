/**
 * Windows single sign-on for the RDP console: an SSPI "Negotiate" client context acquired for the
 * current logon (the same identity VS Code runs as, no password), driven from a dedicated
 * PowerShell session. Mirrors IronRDP's native `ironrdp-vmconnect` CredSSP context.
 */
import type { Logger, SecurityContext } from '@vmm/sdk';
import { PowerShellSession } from './PowerShellSession';

/** C# 5 (Windows PowerShell's Add-Type compiler); compiled once per session. */
const SSPI_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public sealed class VmmSspiContext : IDisposable
{
	[StructLayout(LayoutKind.Sequential)]
	struct SecHandle { public IntPtr Lower; public IntPtr Upper; }

	[StructLayout(LayoutKind.Sequential)]
	struct SecBuffer { public int cbBuffer; public int BufferType; public IntPtr pvBuffer; }

	[StructLayout(LayoutKind.Sequential)]
	struct SecBufferDesc { public int ulVersion; public int cBuffers; public IntPtr pBuffers; }

	[StructLayout(LayoutKind.Sequential)]
	struct SecPkgContextSizes { public int cbMaxToken; public int cbMaxSignature; public int cbBlockSize; public int cbSecurityTrailer; }

	[DllImport("secur32.dll", CharSet = CharSet.Unicode)]
	static extern int AcquireCredentialsHandleW(string principal, string package, int credentialUse, IntPtr logonId, IntPtr authData, IntPtr getKey, IntPtr getKeyArgument, ref SecHandle credential, out long expiry);

	[DllImport("secur32.dll", CharSet = CharSet.Unicode)]
	static extern int InitializeSecurityContextW(ref SecHandle credential, IntPtr context, string targetName, int contextRequirements, int reserved1, int targetDataRepresentation, IntPtr input, int reserved2, IntPtr newContext, IntPtr output, out int contextAttributes, out long expiry);

	[DllImport("secur32.dll")]
	static extern int CompleteAuthToken(IntPtr context, IntPtr token);

	[DllImport("secur32.dll")]
	static extern int QueryContextAttributesW(IntPtr context, int attribute, out SecPkgContextSizes sizes);

	[DllImport("secur32.dll")]
	static extern int EncryptMessage(IntPtr context, int qualityOfProtection, IntPtr message, int sequence);

	[DllImport("secur32.dll")]
	static extern int DecryptMessage(IntPtr context, IntPtr message, int sequence, out int qualityOfProtection);

	[DllImport("secur32.dll")]
	static extern int DeleteSecurityContext(IntPtr context);

	[DllImport("secur32.dll")]
	static extern int FreeCredentialsHandle(ref SecHandle credential);

	const int SECPKG_CRED_OUTBOUND = 2;
	const int SECURITY_NATIVE_DREP = 0x10;
	const int SECBUFFER_EMPTY = 0, SECBUFFER_DATA = 1, SECBUFFER_TOKEN = 2;
	const int ISC_REQ_MUTUAL_AUTH = 0x2, ISC_REQ_CONFIDENTIALITY = 0x10, ISC_REQ_USE_SESSION_KEY = 0x20, ISC_REQ_INTEGRITY = 0x10000;
	const int ISC_RET_CONFIDENTIALITY = 0x10, ISC_RET_INTEGRITY = 0x10000;
	const int SEC_I_CONTINUE_NEEDED = 0x00090312, SEC_I_COMPLETE_NEEDED = 0x00090313, SEC_I_COMPLETE_AND_CONTINUE = 0x00090314;
	const int MAX_TOKEN = 64 * 1024;

	SecHandle credential;
	readonly IntPtr context = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SecHandle)));
	readonly string target;
	bool hasCredential, hasContext;
	SecPkgContextSizes sizes;
	int trailerLength = -1;

	public byte[] Token;
	public bool Complete;

	public VmmSspiContext(string targetName)
	{
		target = targetName;
		Marshal.StructureToPtr(new SecHandle(), context, false);
		long expiry;
		Check(AcquireCredentialsHandleW(null, "Negotiate", SECPKG_CRED_OUTBOUND, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, ref credential, out expiry), "AcquireCredentialsHandle");
		hasCredential = true;
	}

	static void Check(int status, string what)
	{
		if (status != 0) throw new InvalidOperationException(what + " failed: 0x" + status.ToString("X8"));
	}

	sealed class Buffers : IDisposable
	{
		readonly List<IntPtr> allocations = new List<IntPtr>();
		readonly IntPtr array;
		readonly int count;
		public readonly IntPtr Descriptor;

		public Buffers(int[] types, byte[][] contents, int[] capacities)
		{
			count = types.Length;
			int size = Marshal.SizeOf(typeof(SecBuffer));
			array = Alloc(size * count);
			for (int i = 0; i < count; i++)
			{
				int capacity = Math.Max(capacities[i], contents[i] == null ? 0 : contents[i].Length);
				IntPtr data = capacity > 0 ? Alloc(capacity) : IntPtr.Zero;
				if (contents[i] != null && contents[i].Length > 0) Marshal.Copy(contents[i], 0, data, contents[i].Length);
				SecBuffer buffer = new SecBuffer();
				buffer.cbBuffer = contents[i] == null ? capacity : contents[i].Length;
				buffer.BufferType = types[i];
				buffer.pvBuffer = data;
				Marshal.StructureToPtr(buffer, IntPtr.Add(array, i * size), false);
			}
			SecBufferDesc descriptor = new SecBufferDesc();
			descriptor.ulVersion = 0;
			descriptor.cBuffers = count;
			descriptor.pBuffers = array;
			Descriptor = Alloc(Marshal.SizeOf(typeof(SecBufferDesc)));
			Marshal.StructureToPtr(descriptor, Descriptor, false);
		}

		IntPtr Alloc(int bytes)
		{
			IntPtr pointer = Marshal.AllocHGlobal(bytes);
			allocations.Add(pointer);
			return pointer;
		}

		public byte[] Read(int index)
		{
			SecBuffer buffer = (SecBuffer)Marshal.PtrToStructure(IntPtr.Add(array, index * Marshal.SizeOf(typeof(SecBuffer))), typeof(SecBuffer));
			byte[] result = new byte[buffer.cbBuffer];
			if (buffer.cbBuffer > 0) Marshal.Copy(buffer.pvBuffer, result, 0, buffer.cbBuffer);
			return result;
		}

		public void Dispose()
		{
			foreach (IntPtr pointer in allocations) Marshal.FreeHGlobal(pointer);
			allocations.Clear();
		}
	}

	public void Step(byte[] input)
	{
		using (Buffers output = new Buffers(new[] { SECBUFFER_TOKEN }, new byte[][] { null }, new[] { MAX_TOKEN }))
		using (Buffers inputs = hasContext
			? new Buffers(new[] { SECBUFFER_TOKEN, SECBUFFER_EMPTY }, new byte[][] { input ?? new byte[0], null }, new[] { 0, 0 })
			: null)
		{
			int attributes;
			long expiry;
			int requirements = ISC_REQ_MUTUAL_AUTH | ISC_REQ_USE_SESSION_KEY | ISC_REQ_INTEGRITY | ISC_REQ_CONFIDENTIALITY;
			int status = InitializeSecurityContextW(ref credential, hasContext ? context : IntPtr.Zero, target, requirements, 0,
				SECURITY_NATIVE_DREP, inputs == null ? IntPtr.Zero : inputs.Descriptor, 0, context, output.Descriptor, out attributes, out expiry);
			hasContext = true;
			if (status == SEC_I_COMPLETE_NEEDED || status == SEC_I_COMPLETE_AND_CONTINUE) Check(CompleteAuthToken(context, output.Descriptor), "CompleteAuthToken");
			if (status != 0 && status != SEC_I_CONTINUE_NEEDED && status != SEC_I_COMPLETE_NEEDED && status != SEC_I_COMPLETE_AND_CONTINUE)
			{
				Check(status, "InitializeSecurityContext");
			}
			Token = output.Read(0);
			Complete = status == 0 || status == SEC_I_COMPLETE_NEEDED;
			if (Complete)
			{
				int required = ISC_RET_INTEGRITY | ISC_RET_CONFIDENTIALITY;
				if ((attributes & required) != required) throw new InvalidOperationException("The Windows security context has no integrity or confidentiality");
				Check(QueryContextAttributesW(context, 0, out sizes), "QueryContextAttributes");
			}
		}
	}

	public byte[] Encrypt(byte[] data, int sequence)
	{
		using (Buffers buffers = new Buffers(new[] { SECBUFFER_TOKEN, SECBUFFER_DATA }, new byte[][] { null, data }, new[] { sizes.cbSecurityTrailer, 0 }))
		{
			Check(EncryptMessage(context, 0, buffers.Descriptor, sequence), "EncryptMessage");
			byte[] trailer = buffers.Read(0);
			byte[] sealedData = buffers.Read(1);
			trailerLength = trailer.Length;
			byte[] result = new byte[trailer.Length + sealedData.Length];
			Buffer.BlockCopy(trailer, 0, result, 0, trailer.Length);
			Buffer.BlockCopy(sealedData, 0, result, trailer.Length, sealedData.Length);
			return result;
		}
	}

	public byte[] Decrypt(byte[] message, int sequence)
	{
		int trailer = trailerLength >= 0 ? trailerLength : sizes.cbSecurityTrailer;
		if (message.Length < trailer) throw new InvalidOperationException("The sealed message is truncated");
		byte[] token = new byte[trailer];
		byte[] data = new byte[message.Length - trailer];
		Buffer.BlockCopy(message, 0, token, 0, trailer);
		Buffer.BlockCopy(message, trailer, data, 0, data.Length);
		using (Buffers buffers = new Buffers(new[] { SECBUFFER_DATA, SECBUFFER_TOKEN }, new byte[][] { data, token }, new[] { 0, 0 }))
		{
			int quality;
			Check(DecryptMessage(context, buffers.Descriptor, sequence, out quality), "DecryptMessage");
			return buffers.Read(0);
		}
	}

	public void Dispose()
	{
		if (hasContext) DeleteSecurityContext(context);
		hasContext = false;
		if (hasCredential) FreeCredentialsHandle(ref credential);
		hasCredential = false;
		Marshal.FreeHGlobal(context);
	}
}
`;

const OPEN = String.raw`
if (-not ('VmmSspiContext' -as [type])) {
	Add-Type -TypeDefinition $p.source -Language CSharp
}
if (-not $global:vmmSspi) { $global:vmmSspi = @{} }
$global:vmmSspi[$p.id] = New-Object VmmSspiContext -ArgumentList $p.target
[pscustomobject]@{ Ok = $true }
`;

const STEP = String.raw`
$c = $global:vmmSspi[$p.id]
$c.Step([Convert]::FromBase64String($p.input))
[pscustomobject]@{ Token = [Convert]::ToBase64String($c.Token); Complete = [bool]$c.Complete }
`;

const SEAL = String.raw`
$c = $global:vmmSspi[$p.id]
$bytes = [Convert]::FromBase64String($p.data)
$out = if ($p.decrypt) { $c.Decrypt($bytes, [int]$p.sequence) } else { $c.Encrypt($bytes, [int]$p.sequence) }
[pscustomobject]@{ Data = [Convert]::ToBase64String($out) }
`;

const CLOSE = String.raw`
if ($global:vmmSspi -and $global:vmmSspi.ContainsKey($p.id)) {
	$global:vmmSspi[$p.id].Dispose()
	$global:vmmSspi.Remove($p.id)
}
`;

/** The PowerShell side, exported for the syntax test. */
export const SSPI_SCRIPTS = { OPEN, STEP, SEAL, CLOSE };

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const bytes = (value: string) => new Uint8Array(Buffer.from(value, 'base64'));

let nextId = 0;

/** A Negotiate context for the current Windows logon, living in `session` until disposed. */
export async function createWindowsSecurityContext(session: PowerShellSession, targetName: string, log: Logger): Promise<SecurityContext> {
	const id = `ctx${++nextId}`;
	await session.run(OPEN, { id, target: targetName, source: SSPI_SOURCE }, 60_000);
	log.info(`Windows single sign-on context created for ${targetName}`);
	let disposed = false;
	return {
		async step(input) {
			const [result] = await session.run<{ Token: string; Complete: boolean }>(STEP, { id, input: b64(input) }, 30_000);
			if (!result) throw new Error('No answer from the Windows security context');
			return { token: bytes(result.Token ?? ''), complete: !!result.Complete };
		},
		async encrypt(data, sequence) {
			const [result] = await session.run<{ Data: string }>(SEAL, { id, data: b64(data), sequence, decrypt: false });
			return bytes(result?.Data ?? '');
		},
		async decrypt(data, sequence) {
			const [result] = await session.run<{ Data: string }>(SEAL, { id, data: b64(data), sequence, decrypt: true });
			return bytes(result?.Data ?? '');
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			void session.run(CLOSE, { id }).catch(() => undefined);
		}
	};
}
