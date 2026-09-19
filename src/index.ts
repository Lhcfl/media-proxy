import * as fs from "node:fs";
import { Readable } from "node:stream";
import sharp from "sharp";
import type { Config, ResolvedConfig } from "./config.ts";
import { resolveConfig } from "./config.ts";
import { FILE_TYPE_BROWSERSAFE } from "./const.ts";
import { createTemp } from "./create-temp.ts";
import { downloadUrl } from "./download.ts";
import { detectType, isMimeImage } from "./file-info.ts";
import {
	convertSharpToWebp,
	convertToWebp,
	finalize,
	openImage,
	webpDefault,
} from "./image-processor.ts";
import { StatusError } from "./status-error.ts";
import {
	baseHeaders,
	contentDisposition,
	correctFilename,
	Semaphore,
} from "./web.ts";

const DUMMY_IMAGE = new URL("../assets/dummy.png", import.meta.url);

type Prepared =
	| { kind: "buffer"; data: Buffer; ext: string; type: string }
	| { kind: "file"; path: string; ext: string | null; type: string };

export function createHandler(
	config?: Config | null,
): (request: Request) => Promise<Response> {
	const resolved = resolveConfig(config);
	const conversions = new Semaphore(resolved.maxConcurrentConversions);
	return (request: Request) => handleRequest(request, resolved, conversions);
}

async function handleRequest(
	request: Request,
	config: ResolvedConfig,
	conversions: Semaphore,
): Promise<Response> {
	if (request.method === "OPTIONS") {
		return new Response(null, { status: 204, headers: baseHeaders(config) });
	}
	if (request.method !== "GET" && request.method !== "HEAD") {
		return new Response(null, { status: 405, headers: baseHeaders(config) });
	}

	const url = new URL(request.url);
	try {
		return await proxyHandler(request, url, config, conversions);
	} catch (error) {
		return errorHandler(url, config, error);
	}
}

function resolveTarget(url: URL): string | null {
	const queryUrl = url.searchParams.get("url");
	if (queryUrl) return queryUrl;
	if (url.pathname && url.pathname !== "/" && url.pathname !== "/proxy") {
		return `https://${url.pathname.slice(1)}`;
	}
	return null;
}

async function proxyHandler(
	request: Request,
	url: URL,
	config: ResolvedConfig,
	conversions: Semaphore,
): Promise<Response> {
	const params = url.searchParams;
	const target = resolveTarget(url);
	if (!target) {
		return new Response(null, { status: 400, headers: baseHeaders(config) });
	}

	const [tmpPath, cleanup] = await createTemp();
	try {
		const { filename } = await downloadUrl(target, tmpPath, config.download);
		const { mime, ext } = await detectType(tmpPath);

		const wantsImage =
			params.has("emoji") ||
			params.has("avatar") ||
			params.has("static") ||
			params.has("preview") ||
			params.has("badge");

		if (
			wantsImage &&
			mime !== "image/x-icon" &&
			!isMimeImage(mime, "sharp-convertible-image")
		) {
			throw new StatusError("Unexpected mime", 404);
		}

		const passthrough: Prepared = {
			kind: "file",
			path: tmpPath,
			ext,
			type: mime,
		};
		let prepared: Prepared | null = null;

		if (mime === "image/x-icon") {
			// There is no ICO decoder available, so forward the original file even
			// when a conversion was requested.
			prepared = passthrough;
		} else if (params.has("emoji") || params.has("avatar")) {
			if (
				!isMimeImage(mime, "sharp-animation-convertible-image") &&
				!params.has("static")
			) {
				// APNG (and other formats sharp will not re-encode) is passed
				// through untouched, matching upstream behaviour.
				prepared = passthrough;
			} else {
				const maxHeight = params.has("emoji") ? 128 : 320;
				prepared = await withPermit(conversions, async () => {
					const image = (await openImage(tmpPath, mime, !params.has("static")))
						.resize({ height: maxHeight, withoutEnlargement: true })
						.webp(webpDefault);
					return { kind: "buffer", ...(await finalize(image)) };
				});
			}
		} else if (params.has("static")) {
			prepared = await withPermit(conversions, async () => ({
				kind: "buffer",
				...(await convertSharpToWebp(
					await openImage(tmpPath, mime, false),
					498,
					422,
				)),
			}));
		} else if (params.has("preview")) {
			prepared = await withPermit(conversions, async () => ({
				kind: "buffer",
				...(await convertSharpToWebp(
					await openImage(tmpPath, mime, false),
					200,
					200,
				)),
			}));
		} else if (params.has("badge")) {
			prepared = await withPermit(conversions, async () => {
				const mask = (await openImage(tmpPath, mime, false))
					.resize(96, 96, {
						fit: "contain",
						position: "centre",
						withoutEnlargement: false,
					})
					.greyscale()
					.normalise()
					.linear(1.75, -(128 * 1.75) + 128) // 1.75x contrast
					.flatten({ background: "#000" })
					.toColorspace("b-w");

				const stats = await mask.clone().stats();
				if (stats.entropy < 0.1) {
					// Not enough detail to be a useful badge.
					throw new StatusError("Skip to provide badge", 404);
				}

				const data = sharp({
					create: {
						width: 96,
						height: 96,
						channels: 4,
						background: { r: 0, g: 0, b: 0, alpha: 0 },
					},
				})
					.pipelineColorspace("b-w")
					.boolean(await mask.png().toBuffer(), "eor");

				return {
					kind: "buffer",
					data: await data.png().toBuffer(),
					ext: "png",
					type: "image/png",
				};
			});
		} else if (mime === "image/svg+xml") {
			// Rasterise SVG so it cannot execute as a document.
			prepared = await withPermit(conversions, async () => ({
				kind: "buffer",
				...(await convertToWebp(tmpPath, 2048, 2048)),
			}));
		} else if (
			!(mime.startsWith("image/") || FILE_TYPE_BROWSERSAFE.includes(mime))
		) {
			throw new StatusError("Rejected type", 403, "Rejected type");
		}

		prepared ??= passthrough;

		const headers = baseHeaders(config);
		headers.set("Content-Type", prepared.type);
		headers.set("Cache-Control", "max-age=31536000, immutable");
		headers.set(
			"Content-Disposition",
			contentDisposition(correctFilename(filename, prepared.ext)),
		);

		if (prepared.kind === "buffer") {
			cleanup();
			return new Response(prepared.data, { headers });
		}

		return fileResponse(request, prepared.path, cleanup, headers);
	} catch (error) {
		cleanup();
		throw error;
	}
}

async function withPermit<T>(
	semaphore: Semaphore,
	fn: () => Promise<T>,
): Promise<T> {
	const release = await semaphore.acquire();
	try {
		return await fn();
	} finally {
		release();
	}
}

function fileResponse(
	request: Request,
	path: string,
	cleanup: () => void,
	headers: Headers,
): Response {
	let finished = false;
	const finish = () => {
		if (finished) return;
		finished = true;
		cleanup();
	};

	const stream = fs.createReadStream(path);
	stream.on("close", finish);
	stream.on("error", finish);
	request.signal.addEventListener("abort", () => stream.destroy(), {
		once: true,
	});

	return new Response(Readable.toWeb(stream) as ReadableStream, { headers });
}

function errorHandler(
	url: URL,
	config: ResolvedConfig,
	error: unknown,
): Response {
	console.log(
		error instanceof Error ? (error.stack ?? error.message) : String(error),
	);

	const headers = baseHeaders(config);
	headers.set("Cache-Control", "max-age=300");

	if (url.searchParams.has("fallback")) {
		return new Response(Bun.file(DUMMY_IMAGE), { headers, status: 200 });
	}

	if (error instanceof StatusError && error.isClientError) {
		return new Response(null, { status: error.statusCode, headers });
	}

	return new Response(null, { status: 500, headers });
}
