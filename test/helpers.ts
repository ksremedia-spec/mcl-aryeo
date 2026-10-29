import { type AryeoClient, AryeoError, type Query } from "../src/aryeo";

/** Just enough of Cloudflare KV for the StateStore. */
export class MemoryKV {
	data = new Map<string, string>();
	writes = 0;

	async get(key: string, options?: "json" | "text" | { type?: string }): Promise<any> {
		const value = this.data.get(key);
		if (value === undefined) return null;
		const type = typeof options === "string" ? options : options?.type;
		return type === "json" ? JSON.parse(value) : value;
	}

	async put(key: string, value: string): Promise<void> {
		this.writes++;
		this.data.set(key, value);
	}

	async delete(key: string): Promise<void> {
		this.data.delete(key);
	}

	async list({ prefix = "", limit = 1000 }: { prefix?: string; limit?: number } = {}) {
		const keys = [...this.data.keys()]
			.filter((key) => key.startsWith(prefix))
			.sort()
			.slice(0, limit)
			.map((name) => ({ name }));
		return { keys, list_complete: true, cacheStatus: null };
	}

	asKV(): KVNamespace {
		return this as unknown as KVNamespace;
	}
}

export interface Call {
	method: string;
	path: string;
	query?: Query;
	body?: unknown;
}

type Route = (call: Call) => unknown;

/**
 * A pretend Aryeo. `routes` maps "METHOD /path" (exact) to a handler; anything
 * unmatched is a 404. Every call is recorded.
 */
export class FakeAryeo implements AryeoClient {
	log: Call[] = [];
	constructor(public routes: Record<string, Route>) {}

	get calls() {
		return this.log.length;
	}

	private handle(call: Call): unknown {
		this.log.push(call);
		const route = this.routes[`${call.method} ${call.path}`];
		if (!route) throw new AryeoError(404, call.method, call.path, { message: "Not found" });
		return route(call);
	}

	async get(path: string, query?: Query) {
		return this.handle({ method: "GET", path, query });
	}
	async put(path: string, body: unknown) {
		return this.handle({ method: "PUT", path, body });
	}
	async post(path: string, body: unknown) {
		return this.handle({ method: "POST", path, body });
	}

	writes(): Call[] {
		return this.log.filter((call) => call.method !== "GET");
	}
}

/** Serve `items` as Aryeo-style pages of `perPage`, with meta.last_page. */
export function paged(items: unknown[], perPage = 100): Route {
	return (call) => {
		const page = Number(call.query?.page ?? 1);
		const size = Number(call.query?.per_page ?? perPage);
		const lastPage = Math.max(1, Math.ceil(items.length / size));
		return {
			data: items.slice((page - 1) * size, page * size),
			meta: { current_page: page, last_page: lastPage, per_page: size, total: items.length },
		};
	};
}

/** A Census geocoder that always agrees with the pin it's given. */
export function agreeingGeocoder(lat: number, lng: number): typeof fetch {
	return (async () =>
		new Response(JSON.stringify({ result: { addressMatches: [{ matchedAddress: "MATCHED", coordinates: { x: lng, y: lat } }] } }), {
			headers: { "Content-Type": "application/json" },
		})) as unknown as typeof fetch;
}

export const ADDRESS = {
	id: "addr-1",
	street_number: "12",
	street_name: "Harbor Lane",
	city: "Mystic",
	state_or_province: "CT",
	postal_code: "06355",
	latitude: 41.354,
	longitude: -71.966,
};
