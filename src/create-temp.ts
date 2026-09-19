import * as tmp from "tmp";

/**
 * A scratch file with mode 0600 in the system temp directory.
 *
 * Implements `AsyncDisposable`, so `await using temp = await TempFile.create()`
 * disposes it on scope exit, including when the scope throws. When the file is
 * streamed, call `detach()` and dispose it from the response stream instead.
 *
 * The upstream implementation replaced the cleanup callback with a no-op
 * whenever NODE_ENV was not "production", which leaked every download into the
 * service's PrivateTmp tmpfs (i.e. into RAM). Cleanup is unconditional here.
 */
export class TempFile implements AsyncDisposable {
	private disposed = false;
	private detached = false;

	private constructor(
		readonly path: string,
		private readonly cleanupCallback: (next?: () => void) => void,
	) {}

	static create(): Promise<TempFile> {
		return new Promise<TempFile>((resolve, reject) => {
			tmp.file((error, path, _fd, cleanup) => {
				if (error) return reject(error);
				resolve(new TempFile(path, cleanup));
			});
		});
	}

	/** Transfers cleanup responsibility to the caller. */
	detach(): void {
		this.detached = true;
	}

	cleanup(): Promise<void> {
		if (this.disposed) return Promise.resolve();
		this.disposed = true;
		return new Promise<void>((resolve) => {
			// tmp.file()'s callback is asynchronous (fs.unlink); it invokes `next`
			// once the file is gone.
			this.cleanupCallback(resolve);
		});
	}

	async [Symbol.asyncDispose](): Promise<void> {
		if (!this.detached) await this.cleanup();
	}
}
