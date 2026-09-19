import { describe, expect, test } from "bun:test";
import { Semaphore } from "../src/web.ts";

describe("Semaphore", () => {
	test("bounds the number of concurrent holders", async () => {
		const semaphore = new Semaphore(2);
		let active = 0;
		let peak = 0;

		const task = async () => {
			using _permit = await semaphore.acquire();
			active++;
			peak = Math.max(peak, active);
			await Bun.sleep(10);
			active--;
		};

		await Promise.all(Array.from({ length: 8 }, task));
		expect(peak).toBe(2);
	});

	test("releases the permit when the holder throws", async () => {
		const semaphore = new Semaphore(1);

		await expect(
			(async () => {
				using _permit = await semaphore.acquire();
				throw new Error("boom");
			})(),
		).rejects.toThrow("boom");

		// The single permit must be available again.
		using _permit = await semaphore.acquire();
		expect(true).toBe(true);
	});

	test("queued holders run in FIFO order", async () => {
		const semaphore = new Semaphore(1);
		const order: number[] = [];

		const hold = async (id: number) => {
			using _permit = await semaphore.acquire();
			order.push(id);
			await Bun.sleep(5);
		};

		await Promise.all([hold(1), hold(2), hold(3)]);
		expect(order).toEqual([1, 2, 3]);
	});
});
