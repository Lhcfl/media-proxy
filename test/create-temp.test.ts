import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { TempFile } from "../src/create-temp.ts";

describe("TempFile", () => {
	test("disposes on scope exit", async () => {
		let path = "";
		{
			await using temp = await TempFile.create();
			path = temp.path;
			expect(existsSync(path)).toBe(true);
		}
		expect(existsSync(path)).toBe(false);
	});

	test("disposes when the scope throws", async () => {
		let path = "";
		await expect(
			(async () => {
				await using temp = await TempFile.create();
				path = temp.path;
				throw new Error("boom");
			})(),
		).rejects.toThrow("boom");
		expect(existsSync(path)).toBe(false);
	});

	test("detach transfers cleanup to the caller", async () => {
		const holder: TempFile[] = [];
		{
			await using temp = await TempFile.create();
			holder.push(temp);
			temp.detach();
		}

		const temp = holder[0];
		expect(existsSync(temp.path)).toBe(true);
		await temp.cleanup();
		expect(existsSync(temp.path)).toBe(false);
	});

	test("cleanup is idempotent", async () => {
		const temp = await TempFile.create();
		await temp.cleanup();
		await temp.cleanup();
		expect(existsSync(temp.path)).toBe(false);
	});
});
