import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type TempFile = {
	/** Absolute path of the empty file that was created. */
	path: string;
	/** Removes the file and its private directory. Safe to call repeatedly. */
	cleanup: () => Promise<void>;
};

/**
 * Creates a private scratch file under os.tmpdir(). Unlike the original
 * implementation the cleanup callback is always real, so nothing is leaked
 * into the service's tmpfs when NODE_ENV is not "production".
 */
export async function createTemp(): Promise<TempFile> {
	const dir = await mkdtemp(join(tmpdir(), 'misskey-media-proxy-'));
	const path = join(dir, randomUUID());

	// Create eagerly so callers can assume the path exists.
	const handle = await open(path, 'wx', 0o600);
	await handle.close();

	let cleaned = false;
	const cleanup = async () => {
		if (cleaned) return;
		cleaned = true;
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	};

	return { path, cleanup };
}
