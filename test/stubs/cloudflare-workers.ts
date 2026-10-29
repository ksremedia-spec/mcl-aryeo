// Node stand-in for the Workers-only "cloudflare:workers" module, so the real
// OAuth library can run in plain vitest. Only what the library imports is here.
export class WorkerEntrypoint {
	constructor(
		readonly ctx: unknown,
		readonly env: unknown,
	) {}
}
export const env = {};
