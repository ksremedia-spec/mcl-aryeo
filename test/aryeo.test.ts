import { describe, expect, it } from "vitest";
import { AryeoError, asList, asObject, createAryeoClient, getAllPages, resolveOrderId, safeId } from "../src/aryeo";
import { FakeAryeo } from "./helpers";

describe("Aryeo client", () => {
	it("sends the key, Accept: application/json and a User-Agent", async () => {
		const seen: Request[] = [];
		const client = createAryeoClient("secret-key", {
			fetch: (async (url: string, init: RequestInit) => {
				seen.push(new Request(url, init));
				return new Response(JSON.stringify({ data: [] }), { status: 200 });
			}) as unknown as typeof fetch,
		});
		await client.get("/orders", { per_page: 10, sort: "-created_at", include: "appointments" });
		const request = seen[0];
		expect(request.url).toBe("https://api.aryeo.com/v1/orders?per_page=10&sort=-created_at&include=appointments");
		expect(request.headers.get("Authorization")).toBe("Bearer secret-key");
		expect(request.headers.get("Accept")).toBe("application/json");
		expect(request.headers.get("User-Agent")).toMatch(/HorizonHomeMedia/);
	});

	it("turns error responses into AryeoError with Aryeo's message", async () => {
		const client = createAryeoClient("k", {
			fetch: (async () =>
				new Response(JSON.stringify({ message: "The given data was invalid.", errors: { start_at: ["must be a date"] } }), {
					status: 422,
				})) as unknown as typeof fetch,
		});
		const error: any = await client.put("/appointments/a1/schedule", {}).catch((e) => e);
		expect(error).toBeInstanceOf(AryeoError);
		expect(error.status).toBe(422);
		expect(error.isDefinitiveRefusal).toBe(true);
		expect(error.message).toContain("start_at: must be a date");
	});

	it("treats rate limits and auth errors as temporary", () => {
		expect(new AryeoError(429, "GET", "/x", null).isDefinitiveRefusal).toBe(false);
		expect(new AryeoError(403, "GET", "/x", null).isDefinitiveRefusal).toBe(false);
		expect(new AryeoError(503, "GET", "/x", null).isDefinitiveRefusal).toBe(false);
	});
});

describe("response shapes", () => {
	it("handles a bare list and a {data: [...]} list", () => {
		expect(asList([{ id: 1 }])).toEqual([{ id: 1 }]);
		expect(asList({ data: [{ id: 2 }] })).toEqual([{ id: 2 }]);
		expect(asList({ message: "nope" })).toEqual([]);
		expect(asObject({ data: { id: 3 } })).toEqual({ id: 3 });
		expect(asObject({ id: 4 })).toEqual({ id: 4 });
	});

	it("pages until meta.last_page", async () => {
		const items = Array.from({ length: 250 }, (_, i) => ({ id: `a${i}` }));
		const fake = new FakeAryeo({
			"GET /appointments": (call) => {
				const page = Number(call.query?.page);
				return { data: items.slice((page - 1) * 100, page * 100), meta: { last_page: 3 } };
			},
		});
		const result = await getAllPages(fake, "/appointments");
		expect(result.items).toHaveLength(250);
		expect(result.complete).toBe(true);
		expect(fake.log.map((c) => c.query?.page)).toEqual([1, 2, 3]);
	});

	it("pages a bare list until a short page", async () => {
		const items = Array.from({ length: 200 }, (_, i) => ({ id: `a${i}` }));
		const fake = new FakeAryeo({ "GET /appointments": (call) => items.slice((Number(call.query?.page) - 1) * 100, Number(call.query?.page) * 100) });
		const result = await getAllPages(fake, "/appointments");
		expect(result.items).toHaveLength(200);
		expect(fake.log).toHaveLength(3); // the third page comes back empty
	});

	it("reports an incomplete list at the page limit", async () => {
		const fake = new FakeAryeo({ "GET /appointments": () => ({ data: Array(100).fill({ id: "x" }), meta: { last_page: 999 } }) });
		const result = await getAllPages(fake, "/appointments", {}, { maxPages: 3 });
		expect(result.complete).toBe(false);
	});
});

describe("IDs in paths", () => {
	it("rejects anything that could change the URL path", () => {
		expect(() => safeId("../orders")).toThrow();
		expect(() => safeId("a/b")).toThrow();
		expect(() => safeId("a?b=1")).toThrow();
		expect(safeId("00000000-0000-4000-8000-000000000000")).toBe("00000000-0000-4000-8000-000000000000");
	});

	it("finds an order ID from an order number", async () => {
		const fake = new FakeAryeo({ "GET /orders": () => ({ data: [{ id: "o-1", number: 1041 }, { id: "o-2", number: 1042 }], meta: { last_page: 1 } }) });
		expect(await resolveOrderId(fake, "#1042")).toBe("o-2");
		expect(await resolveOrderId(fake, "o-9")).toBe("o-9");
	});
});
