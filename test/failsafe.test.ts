// Cases where Aryeo's answer is surprising, partial or fails half-way. In
// every one of them the check must hold back rather than confirm.

import { afterEach, describe, expect, it, vi } from "vitest";
import { AryeoError, checkedBaseUrl } from "../src/aryeo";
import { type Outcome, runAutoConfirm } from "../src/autoconfirm";
import { StateStore } from "../src/store";
import { ADDRESS, FakeAryeo, MemoryKV, agreeingGeocoder, paged } from "./helpers";

const NOW = Date.parse("2026-11-02T15:00:00Z"); // Mon Nov 2, 10:00 AM EST
const geocoder = agreeingGeocoder(ADDRESS.latitude, ADDRESS.longitude);

const unscheduled = (id: string, preferred: string, extra: Record<string, unknown> = {}) => ({
	id,
	status: "UNSCHEDULED",
	preferred_start_at: preferred,
	duration: 60,
	...extra,
});

function detailRoutes(orders: Record<string, any>) {
	const routes: Record<string, (call: any) => unknown> = {};
	for (const [id, base] of Object.entries(orders)) {
		routes[`GET /orders/${id}`] = (call) =>
			call.query?.include === "items"
				? { data: { ...base, items: base.items ?? [] } }
				: { data: { address: ADDRESS, customer: { name: `Client ${base.number}` }, ...base } };
	}
	return routes;
}

/** Two new requests for overlapping times; the older order (#1060) goes first. */
function twoOverlapping(routes: Record<string, (call: any) => unknown> = {}) {
	return new FakeAryeo({
		"GET /orders": () => ({
			data: [
				{ id: "o-new", number: 1061, created_at: "2026-11-02T14:30:00Z", appointments: [unscheduled("late", "2026-11-06T15:30:00Z")] },
				{ id: "o-old", number: 1060, created_at: "2026-11-02T14:00:00Z", appointments: [unscheduled("early", "2026-11-06T15:00:00Z")] },
			],
		}),
		"GET /appointments": paged([]),
		...detailRoutes({ "o-new": { id: "o-new", number: 1061 }, "o-old": { id: "o-old", number: 1060 } }),
		"PUT /appointments/early/schedule": () => ({}),
		"PUT /appointments/late/schedule": () => ({}),
		...routes,
	});
}

/** One future request on order #1050, with whatever appointment list is given. */
function oneRequest(routes: Record<string, (call: any) => unknown>, appointment = unscheduled("a", "2026-11-04T15:00:00Z")) {
	return new FakeAryeo({
		"GET /orders": () => ({ data: [{ id: "o-a", number: 1050, created_at: "2026-11-02T14:00:00Z", appointments: [appointment] }] }),
		"GET /appointments": paged([]),
		...detailRoutes({ "o-a": { id: "o-a", number: 1050 } }),
		"PUT /appointments/a/schedule": () => ({}),
		...routes,
	});
}

class FailingActivityKV extends MemoryKV {
	override async put(key: string, value: string): Promise<void> {
		if (key.startsWith("activity:")) throw new Error("KV is having a moment");
		return super.put(key, value);
	}
}

const run = (aryeo: FakeAryeo, kv: MemoryKV = new MemoryKV()) =>
	runAutoConfirm({ aryeo, store: new StateStore(kv.asKV()), now: NOW, dryRun: false, source: "auto-check", fetchFn: geocoder });

const puts = (aryeo: FakeAryeo) => aryeo.writes().map((w) => w.path);
const results = (outcomes: Outcome[]) => outcomes.map((o) => o.result);

describe("never confirms on a surprising answer", () => {
	it("an appointment list in an unexpected format", async () => {
		const aryeo = oneRequest({ "GET /appointments": () => ({ appointments: [] }) });
		const report = await run(aryeo);
		expect(puts(aryeo)).toEqual([]);
		expect(results(report.outcomes)).toEqual(["try_again_later"]);
	});

	it("an order list in an unexpected format", async () => {
		const aryeo = oneRequest({ "GET /orders": () => ({ orders: [] }) });
		const report = await run(aryeo);
		expect(report.errors[0]).toMatch(/unexpected format/);
	});

	it("a scheduled appointment whose time can't be read", async () => {
		const aryeo = oneRequest({ "GET /appointments": paged([{ id: "s1", status: "SCHEDULED", start_at: "2026-11-04 10:00:00", end_at: null }]) });
		const report = await run(aryeo);
		expect(puts(aryeo)).toEqual([]);
		const outcome = report.outcomes[0] as Extract<Outcome, { result: "try_again_later" }>;
		expect(outcome.problem).toMatch(/no readable start\/end time/);
	});

	it("an appointment with an unfamiliar status still blocks its slot", async () => {
		const aryeo = oneRequest({
			"GET /appointments": paged([{ id: "s1", status: "CONFIRMED", start_at: "2026-11-04T15:30:00Z", end_at: "2026-11-04T16:30:00Z", order: { id: "o-9", number: 999 } }]),
			...detailRoutes({ "o-9": { id: "o-9", number: 999 } }),
		});
		const report = await run(aryeo);
		expect(puts(aryeo)).toEqual([]);
		expect(results(report.outcomes)).toEqual(["flagged"]);
	});

	it("a preferred time with no time zone", async () => {
		const aryeo = oneRequest({}, unscheduled("a", "2026-11-04 10:00:00"));
		const report = await run(aryeo);
		expect(puts(aryeo)).toEqual([]);
		const outcome = report.outcomes[0] as Extract<Outcome, { result: "flagged" }>;
		expect(outcome.entry.reason).toMatch(/couldn't be read/);
	});

	it("order #1005 when the list doesn't carry the order number", async () => {
		const aryeo = new FakeAryeo({
			"GET /orders": () => ({ data: [{ id: "o-test", appointments: [unscheduled("t", "2026-11-04T15:00:00Z")] }] }),
			"GET /appointments": paged([]),
			...detailRoutes({ "o-test": { id: "o-test", number: 1005 } }),
			"PUT /appointments/t/schedule": () => ({}),
		});
		await run(aryeo);
		expect(puts(aryeo)).toEqual([]);
	});

	it("an order whose number can't be found at all", async () => {
		const aryeo = new FakeAryeo({
			"GET /orders": () => ({ data: [{ id: "o-x", appointments: [unscheduled("x", "2026-11-04T15:00:00Z")] }] }),
			"GET /appointments": paged([]),
			"GET /orders/o-x": () => ({ data: { id: "o-x" } }),
			"PUT /appointments/x/schedule": () => ({}),
		});
		const report = await run(aryeo);
		expect(puts(aryeo)).toEqual([]);
		expect(results(report.outcomes)).toEqual(["try_again_later"]);
	});

	it("products and appointment disagree on the shoot length", async () => {
		const aryeo = oneRequest(
			detailRoutes({ "o-a": { id: "o-a", number: 1050, items: [{ product_variant: { duration: 60 } }] } }),
			unscheduled("a", "2026-11-04T15:00:00Z", { duration: 120 }),
		);
		const report = await run(aryeo);
		expect(puts(aryeo)).toEqual([]);
		const outcome = report.outcomes[0] as Extract<Outcome, { result: "flagged" }>;
		expect(outcome.entry.reason).toMatch(/products add up to 60 minutes but the appointment says 120/);
	});

	it("uses the products' duration as specified when the appointment agrees or has none", async () => {
		const aryeo = oneRequest(
			detailRoutes({ "o-a": { id: "o-a", number: 1050, items: [{ product_variant: { duration: 75 } }, { title: "Floor plan" }] } }),
			unscheduled("a", "2026-11-04T15:00:00Z", { duration: null }),
		);
		await run(aryeo);
		expect(aryeo.writes()[0].body).toEqual({ start_at: "2026-11-04T15:00:00Z", end_at: "2026-11-04T16:15:00Z", notify_customer: false });
	});
});

describe("never double-books after a half-finished step", () => {
	it("Aryeo's answer to a confirmation is lost (timeout/5xx): the slot stays taken for the run", async () => {
		const aryeo = twoOverlapping({
			"PUT /appointments/early/schedule": (call) => {
				throw new AryeoError(504, "PUT", call.path, "gateway timeout");
			},
		});
		const report = await run(aryeo);
		expect(puts(aryeo)).toEqual(["/appointments/early/schedule"]);
		expect(results(report.outcomes)).toEqual(["try_again_later", "flagged"]);
	});

	it("saving to Cloudflare fails right after a confirmation: the slot stays taken", async () => {
		const aryeo = twoOverlapping();
		const report = await run(aryeo, new FailingActivityKV());
		expect(puts(aryeo)).toEqual(["/appointments/early/schedule"]);
		expect(report.errors.length).toBe(2);
	});

	it("a flag that couldn't be logged isn't marked handled, so it comes back next run", async () => {
		const kv = new FailingActivityKV();
		await run(oneRequest({}, unscheduled("a", "2026-11-01T15:00:00Z")), kv);
		expect([...kv.data.keys()].some((key) => key.startsWith("handled:"))).toBe(false);
	});

	it("skips the run while another one holds the lock", async () => {
		const kv = new MemoryKV();
		await new StateStore(kv.asKV()).tryLock(NOW - 30_000, "auto-check");
		const aryeo = oneRequest({});
		const report = await run(aryeo, kv);
		expect(aryeo.log).toEqual([]);
		expect(report.errors[0]).toMatch(/still in progress/);
	});

	it("an old abandoned lock doesn't block forever", async () => {
		const kv = new MemoryKV();
		await new StateStore(kv.asKV()).tryLock(NOW - 10 * 60_000, "auto-check");
		const aryeo = oneRequest({});
		await run(aryeo, kv);
		expect(puts(aryeo)).toEqual(["/appointments/a/schedule"]);
		expect(kv.data.has("lock:auto-confirm")).toBe(false);
	});
});

describe("paging and reading back", () => {
	it("keeps paging a bare list even when Aryeo sends fewer rows than asked for", async () => {
		const book = [
			...Array.from({ length: 50 }, (_, i) => ({ id: `old-${i}`, status: "SCHEDULED", start_at: "2026-01-05T15:00:00Z", end_at: "2026-01-05T16:00:00Z" })),
			{ id: "clash", status: "SCHEDULED", start_at: "2026-11-04T15:30:00Z", end_at: "2026-11-04T16:30:00Z", order: { id: "o-9", number: 999 } },
		];
		const aryeo = oneRequest({
			// Aryeo caps pages at 50 rows and sends a bare array with no paging info.
			"GET /appointments": (call) => book.slice((Number(call.query?.page) - 1) * 50, Number(call.query?.page) * 50),
			...detailRoutes({ "o-9": { id: "o-9", number: 999 } }),
		});
		const report = await run(aryeo);
		expect(puts(aryeo)).toEqual([]);
		expect(results(report.outcomes)).toEqual(["flagged"]);
	});

	it("notes when Aryeo doesn't show the confirmation afterwards", async () => {
		const aryeo = oneRequest({ "GET /appointments/a": () => ({ data: { id: "a", status: "UNSCHEDULED", start_at: null } }) });
		const report = await run(aryeo);
		const outcome = report.outcomes[0] as Extract<Outcome, { result: "confirmed" }>;
		expect(outcome.entry.notes?.join(" ")).toMatch(/Read back from Aryeo: UNSCHEDULED.*Please check it/);
	});

	it("adds no note when the read-back matches", async () => {
		const aryeo = oneRequest({
			"GET /appointments/a": () => ({ data: { id: "a", status: "SCHEDULED", start_at: "2026-11-04T15:00:00Z", end_at: "2026-11-04T16:00:00Z" } }),
		});
		const report = await run(aryeo);
		const outcome = report.outcomes[0] as Extract<Outcome, { result: "confirmed" }>;
		expect(outcome.entry.notes?.join(" ")).not.toMatch(/Read back/);
	});
});

describe("the API key only goes to Aryeo", () => {
	it("accepts Aryeo and local test servers only", () => {
		expect(checkedBaseUrl(undefined)).toBe("https://api.aryeo.com/v1");
		expect(checkedBaseUrl("https://api.aryeo.com/v1/")).toBe("https://api.aryeo.com/v1");
		expect(checkedBaseUrl("http://127.0.0.1:9999/v1")).toBe("http://127.0.0.1:9999/v1");
		expect(() => checkedBaseUrl("https://evil.example/v1")).toThrow();
		expect(() => checkedBaseUrl("http://api.aryeo.com/v1")).toThrow();
	});
});

describe("the 5-minute schedule", () => {
	afterEach(() => vi.unstubAllGlobals());

	async function fire(scheduledTime: number, switchedOn: boolean) {
		const worker = (await import("../src/index")).default;
		const kv = new MemoryKV();
		if (switchedOn) await new StateStore(kv.asKV()).setAutoConfirm(true, "test", NOW);
		const calls: string[] = [];
		vi.stubGlobal("fetch", async (url: string) => {
			calls.push(String(url));
			return Response.json({ data: [] });
		});
		const env = { STATE_KV: kv.asKV(), OAUTH_KV: new MemoryKV().asKV(), ALLOWED_EMAIL: "ksremedia@gmail.com", ARYEO_API_KEY: "k" } as unknown as Env;
		await worker.scheduled!({ scheduledTime, cron: "*/5 0-2,11-23 * * *", noRetry() {} } as ScheduledController, env);
		return { calls, store: new StateStore(kv.asKV()) };
	}

	it("does nothing while switched off", async () => {
		const { calls } = await fire(Date.parse("2026-11-02T15:00:00Z"), false);
		expect(calls).toEqual([]);
	});

	it("does nothing outside 7 AM-9 PM New York time, even when on", async () => {
		expect((await fire(Date.parse("2026-11-02T11:55:00Z"), true)).calls).toEqual([]); // 6:55 AM EST
		expect((await fire(Date.parse("2026-11-03T02:05:00Z"), true)).calls).toEqual([]); // 9:05 PM EST
	});

	it("checks Aryeo when on and inside the hours, and records the run", async () => {
		const { calls, store } = await fire(Date.parse("2026-11-02T12:00:00Z"), true); // 7:00 AM EST
		expect(calls[0]).toBe("https://api.aryeo.com/v1/orders?per_page=10&sort=-created_at&include=appointments");
		expect((await store.getLastRun())?.orders_checked).toBe(0);
	});
});
