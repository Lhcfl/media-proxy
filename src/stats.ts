/**
 * In-memory request statistics for the /stats page.
 *
 * Every successfully proxied file is folded into a one-minute bucket. The last
 * hour is the sum of the recent buckets, so memory is bounded to ~61 buckets
 * regardless of request rate; the totals since start are plain counters.
 * Nothing is persisted: a restart resets everything.
 */

export const MINUTE_MS = 60 * 1000;
export const HOUR_MS = 60 * MINUTE_MS;

/** One-minute aggregation bucket; `minute` is `floor(time / MINUTE_MS)`. */
type Bucket = {
	minute: number;
	files: number;
	/** Bytes downloaded from the upstream server. */
	downloaded: number;
	/** Bytes served to the client (after any conversion). */
	converted: number;
};

export type StatsWindow = {
	/** Files proxied in the window. */
	files: number;
	/** Bytes downloaded in the window. */
	downloaded: number;
	/** Bytes served in the window. */
	converted: number;
	/** Average files per minute over the window. */
	filesPerMinute: number;
};

export type StatsSnapshot = {
	uptimeMs: number;
	hour: StatsWindow;
	total: StatsWindow;
};

export class Stats {
	private readonly startedAt: number;
	/** Minute buckets in insertion order (oldest first). */
	private readonly buckets = new Map<number, Bucket>();
	private totalFiles = 0;
	private totalDownloaded = 0;
	private totalConverted = 0;

	constructor(startedAt: number = Date.now()) {
		this.startedAt = startedAt;
	}

	record(
		downloaded: number,
		converted: number,
		time: number = Date.now(),
	): void {
		const minute = Math.floor(time / MINUTE_MS);
		let bucket = this.buckets.get(minute);
		if (!bucket) {
			bucket = { minute, files: 0, downloaded: 0, converted: 0 };
			this.buckets.set(minute, bucket);
		}
		bucket.files += 1;
		bucket.downloaded += downloaded;
		bucket.converted += converted;

		this.totalFiles += 1;
		this.totalDownloaded += downloaded;
		this.totalConverted += converted;
		this.prune(time);
	}

	/** Drops buckets that ended before the start of the rolling hour. */
	private prune(now: number): void {
		const cutoff = now - HOUR_MS;
		for (const [minute, bucket] of this.buckets) {
			if ((minute + 1) * MINUTE_MS > cutoff) break;
			this.buckets.delete(bucket.minute);
		}
	}

	/** Number of live minute buckets; bounded to ~61 (one rolling hour). */
	get bucketCount(): number {
		return this.buckets.size;
	}

	snapshot(now: number = Date.now()): StatsSnapshot {
		this.prune(now);

		let hourFiles = 0;
		let hourDownloaded = 0;
		let hourConverted = 0;
		for (const bucket of this.buckets.values()) {
			hourFiles += bucket.files;
			hourDownloaded += bucket.downloaded;
			hourConverted += bucket.converted;
		}

		const uptimeMs = Math.max(0, now - this.startedAt);
		// A freshly started server has not been observing for a full hour, so
		// the per-minute average uses the shorter elapsed time instead.
		const hourElapsed = Math.min(uptimeMs, HOUR_MS);

		return {
			uptimeMs,
			hour: {
				files: hourFiles,
				downloaded: hourDownloaded,
				converted: hourConverted,
				filesPerMinute: perMinute(hourFiles, hourElapsed),
			},
			total: {
				files: this.totalFiles,
				downloaded: this.totalDownloaded,
				converted: this.totalConverted,
				filesPerMinute: perMinute(this.totalFiles, uptimeMs),
			},
		};
	}
}

function perMinute(files: number, elapsedMs: number): number {
	if (elapsedMs <= 0) return 0;
	return files / (elapsedMs / 60_000);
}

function megabytes(bytes: number): string {
	return (bytes / 1024 / 1024).toFixed(2);
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function formatUptime(ms: number): string {
	const totalMinutes = Math.floor(ms / 60_000);
	const days = Math.floor(totalMinutes / (60 * 24));
	const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) return `${days}d ${hours}h ${minutes}m`;
	if (hours > 0) return `${hours}h ${minutes}m`;
	return `${minutes}m`;
}

export function renderStatsPage(snapshot: StatsSnapshot): string {
	const { hour, total } = snapshot;
	const row = (label: string, window: StatsWindow) => `
			<tr>
				<th scope="row">${escapeHtml(label)}</th>
				<td>${window.files.toLocaleString("en-US")}</td>
				<td>${megabytes(window.downloaded)} MB</td>
				<td>${megabytes(window.converted)} MB</td>
				<td>${window.filesPerMinute.toFixed(2)}</td>
			</tr>`;

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="15">
<title>Media proxy statistics</title>
<style>
	:root { color-scheme: light dark; }
	body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 52rem; padding: 0 1rem; }
	h1 { font-size: 1.4rem; }
	table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
	th, td { text-align: right; padding: 0.5rem 0.75rem; border-bottom: 1px solid #8884; }
	th[scope="row"] { text-align: left; }
	thead th { text-align: right; font-size: 0.85rem; opacity: 0.75; }
	thead th:first-child { text-align: left; }
	footer { margin-top: 1rem; font-size: 0.8rem; opacity: 0.7; }
</style>
</head>
<body>
<h1>Media proxy statistics</h1>
<table>
	<thead>
		<tr>
			<th scope="col">Window</th>
			<th scope="col">Files</th>
			<th scope="col">Downloaded</th>
			<th scope="col">Served</th>
			<th scope="col">Files / min</th>
		</tr>
	</thead>
	<tbody>${row("Last hour", hour)}${row("Since start", total)}
	</tbody>
</table>
<footer>Uptime: ${escapeHtml(formatUptime(snapshot.uptimeMs))} &middot; refreshes every 15 s</footer>
</body>
</html>
`;
}
