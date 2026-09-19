export class StatusError extends Error {
	readonly statusCode: number;
	readonly statusMessage: string | undefined;

	constructor(message: string, statusCode: number, statusMessage?: string) {
		super(message);
		this.name = 'StatusError';
		this.statusCode = statusCode;
		this.statusMessage = statusMessage;
	}

	get isClientError(): boolean {
		return this.statusCode >= 400 && this.statusCode < 500;
	}
}
