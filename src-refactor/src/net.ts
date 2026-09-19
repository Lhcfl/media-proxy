import { isIP } from 'node:net';
import { StatusError } from './status-error.ts';

/**
 * Private / special-use ranges that must not be reachable through the proxy.
 * This mirrors the intent of ipaddr.js#range() !== "unicast" for the ranges
 * that matter here, without the dependency.
 */
const SPECIAL_V4: Array<[string, number]> = [
	['0.0.0.0', 8],
	['10.0.0.0', 8],
	['100.64.0.0', 10],
	['127.0.0.0', 8],
	['169.254.0.0', 16],
	['172.16.0.0', 12],
	['192.0.0.0', 24],
	['192.0.2.0', 24],
	['192.168.0.0', 16],
	['198.18.0.0', 15],
	['198.51.100.0', 24],
	['203.0.113.0', 24],
	['224.0.0.0', 4],
	['240.0.0.0', 4],
];

const SPECIAL_V6: Array<[string, number]> = [
	['::', 128],
	['::1', 128],
	['::ffff:0:0', 96],
	['64:ff9b::', 96],
	['100::', 64],
	['2001:db8::', 32],
	['fc00::', 7],
	['fe80::', 10],
	['ff00::', 8],
];

function ipv4ToBigInt(ip: string): bigint {
	let value = 0n;
	for (const part of ip.split('.')) value = (value << 8n) | BigInt(Number(part));
	return value;
}

function ipv6ToBytes(input: string): number[] | null {
	let s = input;
	const zone = s.indexOf('%');
	if (zone !== -1) s = s.slice(0, zone);

	let v4: number[] | null = null;
	if (s.includes('.')) {
		const lastColon = s.lastIndexOf(':');
		const tail = s.slice(lastColon + 1);
		if (isIP(tail) !== 4) return null;
		v4 = tail.split('.').map(Number);
		s = s.slice(0, lastColon + 1) + 'v4';
	}

	const halves = s.split('::');
	if (halves.length > 2) return null;

	const parseGroups = (part: string): number[] | null => {
		if (part === '') return [];
		const out: number[] = [];
		for (const group of part.split(':')) {
			if (group === 'v4') {
				if (!v4) return null;
				out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
				continue;
			}
			if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
			out.push(parseInt(group, 16));
		}
		return out;
	};

	const left = parseGroups(halves[0]);
	const right = parseGroups(halves.length === 2 ? halves[1] : '');
	if (!left || !right) return null;

	let groups: number[];
	if (halves.length === 2) {
		const zeros = 8 - left.length - right.length;
		if (zeros < 0) return null;
		groups = [...left, ...new Array(zeros).fill(0), ...right];
	} else {
		groups = left;
	}
	if (groups.length !== 8) return null;

	const bytes: number[] = [];
	for (const group of groups) bytes.push((group >> 8) & 0xff, group & 0xff);
	return bytes;
}

function ipToBigInt(ip: string): { value: bigint; bits: number } | null {
	const version = isIP(ip);
	if (version === 4) return { value: ipv4ToBigInt(ip), bits: 32 };
	if (version === 6) {
		const bytes = ipv6ToBytes(ip);
		if (!bytes) return { value: 0n, bits: 128 };
		let value = 0n;
		for (const byte of bytes) value = (value << 8n) | BigInt(byte);
		return { value, bits: 128 };
	}
	return null;
}

function inCidr(value: bigint, bits: number, base: bigint, prefix: number): boolean {
	if (prefix > bits) return false;
	const shift = BigInt(bits - prefix);
	return (value >> shift) === (base >> shift);
}

function matchesAny(ip: string, networks: Array<[string, number]>): boolean {
	const parsed = ipToBigInt(ip);
	if (!parsed) return false;
	for (const [network, prefix] of networks) {
		const base = ipToBigInt(network);
		if (!base || base.bits !== parsed.bits) continue;
		if (inCidr(parsed.value, parsed.bits, base.value, prefix)) return true;
	}
	return false;
}

/** True when `ip` falls in a private / special-use range. */
export function isPrivateIp(ip: string): boolean {
	return matchesAny(ip, [...SPECIAL_V4, ...SPECIAL_V6]);
}

/** True when `ip` matches one of the administrator-allowed CIDR blocks. */
export function isAllowedIp(ip: string, allowed: string[]): boolean {
	for (const cidr of allowed) {
		const slash = cidr.indexOf('/');
		if (slash === -1) {
			if (ip === cidr) return true;
			continue;
		}
		const network = cidr.slice(0, slash);
		const prefix = Number(cidr.slice(slash + 1));
		const parsed = ipToBigInt(ip);
		const base = ipToBigInt(network);
		if (!parsed || !base || base.bits !== parsed.bits) continue;
		if (inCidr(parsed.value, parsed.bits, base.value, prefix)) return true;
	}
	return false;
}

function stripBrackets(hostname: string): string {
	if (hostname.startsWith('[') && hostname.endsWith(']')) return hostname.slice(1, -1);
	return hostname;
}

/**
 * Rejects URLs whose host resolves to a private address. Bun's fetch does not
 * expose the peer IP, so this resolves the name up front. That leaves a small
 * DNS-rebinding window that the original (which inspected the connected socket)
 * did not have.
 */
export async function assertHostAllowed(hostname: string, allowed: string[]): Promise<void> {
	const host = stripBrackets(hostname);

	const check = (ip: string) => {
		if (!isPrivateIp(ip)) return;
		if (isAllowedIp(ip, allowed)) return;
		throw new StatusError(`Blocked address: ${ip}`, 403, 'Blocked address');
	};

	if (isIP(host)) {
		check(host);
		return;
	}

	let addresses: Array<{ address: string }>;
	try {
		addresses = await Bun.dns.lookup(host);
	} catch {
		// Let fetch produce the real error for unresolvable hosts.
		return;
	}
	for (const { address } of addresses) check(address);
}
