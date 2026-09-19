import * as tmp from 'tmp';

/**
 * Creates a scratch file with mode 0600 in the system temp directory.
 *
 * The upstream implementation replaced the cleanup callback with a no-op
 * whenever NODE_ENV was not "production", which leaked every download into the
 * service's PrivateTmp tmpfs (i.e. into RAM). Cleanup is unconditional here.
 */
export function createTemp(): Promise<[path: string, cleanup: () => void]> {
	return new Promise<[string, () => void]>((resolve, reject) => {
		tmp.file((error, path, _fd, cleanup) => {
			if (error) return reject(error);
			resolve([path, cleanup]);
		});
	});
}
