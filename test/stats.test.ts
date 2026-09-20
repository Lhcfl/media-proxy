import { describe, expect, test } from "bun:test";
import { MINUTE_MS, renderStatsPage, Stats } from "../src/stats.ts";

describe("Stats", () => {
	test("aggregates totals and the last hour", () => {
		const stats = new Stats(0);
		stats.record(1000, 500, 10_000);
		stats.record(2000, 1000, 20_000);

		const snapshot = stats.snapshot(30_000);
		expect(snapshot.hour.files).toBe(2);
		expect(snapshot.hour.downloaded).toBe(3000);
		expect(snapshot.hour.converted).toBe(1500);
		expect(snapshot.total.files).toBe(2);

		// Two files over 0.5 minutes of uptime => 4 files/min.
		expect(snapshot.total.filesPerMinute).toBeCloseTo(4);
	});

	test("drops buckets that ended before the rolling hour", () => {
		const stats = new Stats(0);
		stats.record(100, 100, 0);
		stats.record(200, 200, 50 * MINUTE_MS);

		const snapshot = stats.snapshot(61 * MINUTE_MS);
		expect(snapshot.hour.files).toBe(1);
		expect(snapshot.hour.downloaded).toBe(200);
		expect(snapshot.total.files).toBe(2);
		expect(snapshot.total.downloaded).toBe(300);
	});

	test("bounds memory to about one hour of minute buckets", () => {
		const stats = new Stats(0);
		// One request every minute for 24 hours.
		for (let minute = 0; minute < 24 * 60; minute++) {
			stats.record(1, 1, minute * MINUTE_MS);
		}

		const snapshot = stats.snapshot((24 * 60 - 1) * MINUTE_MS);
		expect(stats.bucketCount).toBe(61);
		expect(snapshot.hour.files).toBe(61);
		expect(snapshot.total.files).toBe(24 * 60);
	});

	test("per-minute average is zero before any time has elapsed", () => {
		const stats = new Stats(1000);
		const snapshot = stats.snapshot(1000);
		expect(snapshot.total.filesPerMinute).toBe(0);
		expect(snapshot.hour.filesPerMinute).toBe(0);
	});
});

describe("renderStatsPage", () => {
	test("renders totals in the table", () => {
		const stats = new Stats(0);
		stats.record(1024 * 1024, 512 * 1024, 1000);
		const html = renderStatsPage(stats.snapshot(60_000));
		expect(html).toContain("Last hour");
		expect(html).toContain("Since start");
		expect(html).toContain("1.00 MB");
		expect(html).toContain("0.50 MB");
		expect(html).toContain("<table>");
	});
});
