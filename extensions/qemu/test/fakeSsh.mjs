#!/usr/bin/env node
// A stand-in for `ssh` in tests: runs the "remote" command with the local shell and forwards `-W` to a
// local TCP port, so the SSH host code can be exercised on one machine without sshd.
import { spawn } from 'node:child_process';
import net from 'node:net';

const args = process.argv.slice(2);
let forward;
let exit = false;
let destination;
const takesValue = new Set(['-o', '-p', '-l', '-i', '-W', '-O', '-F', '-J']);
for (let i = 0; i < args.length; i++) {
	const arg = args[i];
	if (takesValue.has(arg)) {
		const value = args[++i];
		if (arg === '-W') forward = value;
		if (arg === '-O' && value === 'exit') exit = true;
	} else if (arg.startsWith('-')) {
		continue;
	} else {
		destination = arg;
		args.splice(0, i + 1);
		break;
	}
}
if (exit) process.exit(0);
if (!destination) {
	console.error('fake ssh: no destination');
	process.exit(255);
}
if (destination === 'unreachable.invalid') {
	console.error('ssh: Could not resolve hostname unreachable.invalid: Name or service not known');
	process.exit(255);
}
if (forward) {
	const [host, port] = [forward.slice(0, forward.lastIndexOf(':')), Number(forward.slice(forward.lastIndexOf(':') + 1))];
	const socket = net.connect({ host, port });
	socket.once('connect', () => {
		process.stdin.pipe(socket);
		socket.pipe(process.stdout);
	});
	socket.once('error', (e) => {
		console.error(`connect_to ${host} port ${port}: failed. (${e.code})`);
		process.exit(255);
	});
	socket.once('close', () => process.exit(0));
	process.stdin.once('end', () => socket.end());
} else {
	const child = spawn('sh', ['-c', args.join(' ')], { stdio: 'inherit' });
	child.on('exit', (code) => process.exit(code ?? 255));
}
