// Thin Aryeo REST client plus the response-shape quirks noted during setup:
// - lists come back either as a bare array or as {"data": [...]}
// - combining more than one `include` returns 400, so details are fetched one include at a time
// - some endpoints answer 403 without `Accept: application/json`

export const DEFAULT_BASE_URL = "https://api.aryeo.com/v1";
const USER_AGENT = "HorizonHomeMedia-AryeoConnector/1.0";
const REQUEST_TIMEOUT_MS = 20_000;

/** Order #1005 is an old test record and is always ignored. */
export const IGNORED_ORDER_NUMBERS = new Set(["1005"]);

export type Query = Record<string, string | number | undefined>;

export class AryeoError extends Error {
	constructor(
		readonly status: number,
		readonly method: string,
		readonly path: string,
		readonly body: unknown,
	) {
		super(`Aryeo ${method} ${path} failed with HTTP ${status}${describeErrorBody(body)}`);
		this.name = "AryeoError";
	}

	/**
	 * Aryeo looked at the request and said no (bad data, not allowed, conflict).
	 * As opposed to a temporary problem worth retrying on the next run.
	 */
	get isDefinitiveRefusal(): boolean {
		return this.status >= 400 && this.status < 500 && ![401, 403, 408, 429].includes(this.status);
	}
}

function describeErrorBody(body: unknown): string {
	if (!body || typeof body !== "object") return typeof body === "string" && body ? `: ${body.slice(0, 300)}` : "";
	const b = body as Record<string, unknown>;
	const parts: string[] = [];
	if (typeof b.message === "string") parts.push(b.message);
	if (b.errors && typeof b.errors === "object") {
		for (const [field, messages] of Object.entries(b.errors as Record<string, unknown>)) {
			parts.push(`${field}: ${Array.isArray(messages) ? messages.join(" ") : String(messages)}`);
		}
	}
	return parts.length ? `: ${parts.join("; ").slice(0, 500)}` : "";
}

export interface AryeoClient {
	get(path: string, query?: Query): Promise<unknown>;
	put(path: string, body: unknown): Promise<unknown>;
	post(path: string, body: unknown): Promise<unknown>;
	/** Number of HTTP calls made so far (for the run summary). */
	readonly calls: number;
}

export function createAryeoClient(
	apiKey: string,
	options: { baseUrl?: string; fetch?: typeof fetch } = {},
): AryeoClient {
	const baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
	const doFetch = options.fetch ?? fetch;
	let calls = 0;

	async function request(method: string, path: string, query?: Query, body?: unknown): Promise<unknown> {
		const url = new URL(baseUrl + path);
		for (const [key, value] of Object.entries(query ?? {})) {
			if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
		}
		const headers: Record<string, string> = {
			Authorization: `Bearer ${apiKey}`,
			Accept: "application/json",
			"User-Agent": USER_AGENT,
		};
		if (body !== undefined) headers["Content-Type"] = "application/json";
		calls++;
		const response = await doFetch(url.toString(), {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		const text = await response.text();
		let parsed: unknown = text;
		if (text) {
			try {
				parsed = JSON.parse(text);
			} catch {
				// keep the raw text
			}
		}
		if (!response.ok) throw new AryeoError(response.status, method, path, parsed);
		return parsed;
	}

	return {
		get: (path, query) => request("GET", path, query),
		put: (path, body) => request("PUT", path, undefined, body),
		post: (path, body) => request("POST", path, undefined, body),
		get calls() {
			return calls;
		},
	};
}

/**
 * IDs go into URL paths, so only plain ID characters are allowed. This stops a
 * crafted value like "x/../../orders" from turning a call into a different one.
 */
export function safeId(value: unknown, what = "ID"): string {
	const text = String(value ?? "").trim();
	if (!/^[A-Za-z0-9_-]{1,80}$/.test(text)) throw new Error(`That doesn't look like a valid Aryeo ${what}: "${text}"`);
	return text;
}

/** Bare list or {"data": [...]} → array. */
export function asList(body: unknown): any[] {
	if (Array.isArray(body)) return body;
	if (body && typeof body === "object" && Array.isArray((body as any).data)) return (body as any).data;
	return [];
}

/** {"data": {...}} or {...} → object. */
export function asObject(body: unknown): any {
	if (body && typeof body === "object" && !Array.isArray(body)) {
		const data = (body as any).data;
		if (data && typeof data === "object" && !Array.isArray(data)) return data;
		return body;
	}
	return null;
}

function hasMorePages(body: unknown, page: number, perPage: number, count: number): boolean {
	if (body && typeof body === "object" && !Array.isArray(body)) {
		const meta = (body as any).meta;
		const lastPage = Number(meta?.last_page);
		if (Number.isFinite(lastPage) && lastPage > 0) return page < lastPage;
		const links = (body as any).links;
		if (links && typeof links === "object" && "next" in links) return Boolean(links.next);
	}
	return count >= perPage;
}

export interface PagedResult {
	items: any[];
	/** False when we stopped at the page limit with more pages still left. */
	complete: boolean;
	pages: number;
}

export async function getAllPages(
	client: AryeoClient,
	path: string,
	query: Query = {},
	{ perPage = 100, maxPages = 200 }: { perPage?: number; maxPages?: number } = {},
): Promise<PagedResult> {
	const items: any[] = [];
	for (let page = 1; page <= maxPages; page++) {
		const body = await client.get(path, { ...query, per_page: perPage, page });
		const list = asList(body);
		items.push(...list);
		if (list.length === 0 || !hasMorePages(body, page, perPage, list.length)) {
			return { items, complete: true, pages: page };
		}
	}
	return { items, complete: false, pages: maxPages };
}

/**
 * Every appointment, paging through GET /appointments?per_page=100&page=N.
 * Asks for each appointment's order too (one include, which Aryeo allows) so a
 * clash can name the other order; falls back to the plain list if Aryeo rejects that.
 */
export async function listAllAppointments(client: AryeoClient, maxPages = 200): Promise<PagedResult> {
	try {
		return await getAllPages(client, "/appointments", { include: "order" }, { maxPages });
	} catch (error) {
		if (error instanceof AryeoError && error.status === 400) {
			return getAllPages(client, "/appointments", {}, { maxPages });
		}
		throw error;
	}
}

/**
 * One order with extra pieces merged in. Each include is its own request because
 * combining them is a 400. Includes Aryeo doesn't recognise are skipped and noted.
 */
export async function getOrderWithIncludes(
	client: AryeoClient,
	orderId: string,
	includes: string[],
): Promise<{ order: any; skippedIncludes: string[] }> {
	const id = safeId(orderId, "order ID");
	const order = asObject(await client.get(`/orders/${id}`)) ?? {};
	const skippedIncludes: string[] = [];
	for (const include of includes) {
		if (order[include] !== undefined && order[include] !== null) continue;
		try {
			const extra = asObject(await client.get(`/orders/${id}`, { include }));
			if (extra && extra[include] !== undefined) order[include] = extra[include];
			else skippedIncludes.push(include);
		} catch (error) {
			if (error instanceof AryeoError && (error.status === 400 || error.status === 422)) skippedIncludes.push(include);
			else throw error;
		}
	}
	return { order, skippedIncludes };
}

/**
 * Accepts an order number ("1042", "#1042") or an order ID. Order numbers are
 * found by scanning the newest orders first.
 */
export async function resolveOrderId(client: AryeoClient, orderRef: string, maxPages = 20): Promise<string> {
	const ref = String(orderRef).trim().replace(/^#/, "");
	if (!/^\d{1,9}$/.test(ref)) return safeId(ref, "order ID");
	for (let page = 1; page <= maxPages; page++) {
		const body = await client.get("/orders", { per_page: 50, page, sort: "-created_at" });
		const list = asList(body);
		const match = list.find((order) => String(order?.number) === ref);
		if (match?.id) return safeId(match.id, "order ID");
		if (list.length === 0 || !hasMorePages(body, page, 50, list.length)) break;
	}
	throw new Error(`Couldn't find order #${ref} in the newest ${maxPages * 50} orders.`);
}

/**
 * One appointment by ID. Uses GET /appointments/{id} if Aryeo has it, otherwise
 * searches the full appointment list.
 */
export async function findAppointment(client: AryeoClient, appointmentId: string): Promise<any | null> {
	const id = safeId(appointmentId, "appointment ID");
	try {
		const direct = asObject(await client.get(`/appointments/${id}`, { include: "order" }));
		if (direct?.id) return direct;
	} catch (error) {
		if (!(error instanceof AryeoError) || ![400, 404, 405].includes(error.status)) throw error;
	}
	const all = await listAllAppointments(client);
	return all.items.find((appointment) => String(appointment?.id) === id) ?? null;
}
