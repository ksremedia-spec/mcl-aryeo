import { describe, expect, it } from "vitest";
import { AryeoError } from "../src/aryeo";
import { type Outcome, runAutoConfirm } from "../src/autoconfirm";
import { StateStore } from "../src/store";
import { ADDRESS, FakeAryeo, MemoryKV, agreeingGeocoder, paged } from "./helpers";

const NOW = Date.parse("2026-11-02T15:00:00Z"); // Mon Nov 2, 10:00 AM EST
const geocoder = agreeingGeocoder(ADDRESS.latitude, ADDRESS.longitude);

function order(id: string, number: number, createdAt: string, appointments: any[], extra: Record<string, unknown> = {}) {
	return { id, number, created_at: createdAt, appointments, ...extra };
}

function unscheduled(id: string, preferred: string, extra: Record<string, unknown> = {}) {
	return { id, status: "UNSCHEDULED", preferred_start_at: preferred, start_at: null, end_at: null, duration: 90, ...extra };
}

function scheduled(id: string, start: string, end: string, orderRef: { id: string; number: number }) {
	return { id, status: "SCHEDULED", start_at: start, end_at: end, order: orderRef };
}

/** 150 old appointments, plus whatever is passed in, so clashes are found on page 2. */
function appointmentBook(extra: any[]) {
	const filler = Array.from({ length: 150 }, (_, i) =>
		scheduled(`old-${i}`, "2026-01-05T15:00:00Z", "2026-01-05T16:00:00Z", { id: `o-old-${i}`, number: 900 + i }),
	);
	return [...filler.slice(0, 120), ...extra, ...filler.slice(120)];
}

function orderDetailRoutes(orders: Record<string, any>) {
	const routes: Record<string, (call: any) => unknown> = {};
	for (const [id, base] of Object.entries(orders)) {
		routes[`GET /orders/${id}`] = (call) => {
			const include = call.query?.include;
			if (include === "items") return { data: { ...base, items: base.items ?? [] } };
			return { data: { ...base, address: ADDRESS, customer: { name: `Client of ${base.number}` } } };
		};
	}
	return routes;
}

function standardScenario(overrides: Record<string, (call: any) => unknown> = {}) {
	const orders = [
		order("o-a", 1050, "2026-11-02T14:00:00Z", [unscheduled("a-new", "2026-11-04T15:00:00Z")]),
		order("o-test", 1005, "2026-11-02T13:00:00Z", [unscheduled("t-1", "2026-11-04T18:00:00Z")]),
		order("o-b", 1049, "2026-11-01T14:00:00Z", [unscheduled("b-past", "2026-11-01T15:00:00Z")]),
		order("o-c", 1048, "2026-10-31T14:00:00Z", [unscheduled("c-clash", "2026-11-05T15:00:00Z", { duration: 60 })]),
		order("o-d", 1047, "2026-10-30T14:00:00Z", [scheduled("d-done", "2026-11-03T15:00:00Z", "2026-11-03T16:00:00Z", { id: "o-d", number: 1047 })]),
	];
	const book = appointmentBook([
		scheduled("existing-1001", "2026-11-05T15:30:00Z", "2026-11-05T16:30:00Z", { id: "o-1001", number: 1001 }),
		{ ...unscheduled("a-new", "2026-11-04T15:00:00Z"), order: { id: "o-a", number: 1050 } },
	]);
	return new FakeAryeo({
		"GET /orders": () => ({ data: orders }),
		"GET /appointments": paged(book),
		...orderDetailRoutes({
			"o-a": { id: "o-a", number: 1050 },
			"o-b": { id: "o-b", number: 1049 },
			"o-c": { id: "o-c", number: 1048 },
			"o-1001": { id: "o-1001", number: 1001 },
		}),
		"PUT /appointments/a-new/schedule": () => ({ data: { id: "a-new", status: "SCHEDULED" } }),
		// Read-back after confirming.
		"GET /appointments/a-new": () => ({
			data: { id: "a-new", status: "SCHEDULED", start_at: "2026-11-04T15:00:00Z", end_at: "2026-11-04T16:30:00Z" },
		}),
		...overrides,
	});
}

function context(aryeo: FakeAryeo, kv: MemoryKV, dryRun = false) {
	return { aryeo, store: new StateStore(kv.asKV()), now: NOW, dryRun, source: "auto-check" as const, fetchFn: geocoder };
}

const byResult = (outcomes: Outcome[], result: Outcome["result"]) => outcomes.filter((o) => o.result === result);

describe("auto-confirm check", () => {
	it("confirms, flags and ignores exactly as the rules say", async () => {
		const aryeo = standardScenario();
		const kv = new MemoryKV();
		const report = await runAutoConfirm(context(aryeo, kv));

		expect(aryeo.log[0]).toMatchObject({ method: "GET", path: "/orders", query: { per_page: 10, sort: "-created_at", include: "appointments" } });

		// One confirmation, for the preferred time plus the 90-minute duration, and no notification flag.
		expect(aryeo.writes()).toEqual([
			{ method: "PUT", path: "/appointments/a-new/schedule", body: { start_at: "2026-11-04T15:00:00Z", end_at: "2026-11-04T16:30:00Z", notify_customer: false } },
		]);

		const confirmed = byResult(report.outcomes, "confirmed");
		expect(confirmed).toHaveLength(1);

		const flagged = byResult(report.outcomes, "flagged") as Extract<Outcome, { result: "flagged" }>[];
		expect(flagged.map((f) => f.entry.booking.order_number).sort()).toEqual(["1048", "1049"]);

		const past = flagged.find((f) => f.entry.booking.order_number === "1049")!;
		expect(past.entry.reason).toMatch(/in the past/);

		const clash = flagged.find((f) => f.entry.booking.order_number === "1048")!;
		expect(clash.entry.reason).toBe("Scheduling conflict, needs manual review.");
		expect(clash.entry.conflict_with).toMatchObject({ order_number: "1001", client: "Client of 1001", address: "12 Harbor Lane, Mystic, CT 06355" });
		expect(clash.entry.booking).toMatchObject({ client: "Client of 1048", address: "12 Harbor Lane, Mystic, CT 06355" });

		// #1005 never shows up at all.
		expect(JSON.stringify(report)).not.toContain("t-1");
		// The clash was on page 2 of the appointment list, so paging happened.
		expect(aryeo.log.filter((c) => c.path === "/appointments").map((c) => c.query?.page)).toEqual([1, 2]);

		const activity = await new StateStore(kv.asKV()).listActivity(10);
		expect(activity.map((a) => a.kind).sort()).toEqual(["confirmed", "flagged", "flagged"]);
	});

	it("never handles the same booking twice", async () => {
		const kv = new MemoryKV();
		await runAutoConfirm(context(standardScenario(), kv));

		// Next run: Aryeo still shows the same requests (e.g. not yet refreshed).
		const second = standardScenario();
		const report = await runAutoConfirm(context(second, kv));
		expect(second.writes()).toEqual([]);
		expect(report.outcomes.every((o) => o.result === "already_handled")).toBe(true);
		expect((await new StateStore(kv.asKV()).listActivity(10)).length).toBe(3);
	});

	it("preview mode changes nothing", async () => {
		const aryeo = standardScenario();
		const kv = new MemoryKV();
		const report = await runAutoConfirm(context(aryeo, kv, true));
		expect(aryeo.writes()).toEqual([]);
		expect(kv.writes).toBe(0);
		expect(byResult(report.outcomes, "confirmed")).toHaveLength(1);
		expect(byResult(report.outcomes, "flagged")).toHaveLength(2);
	});

	it("handles an order list that comes back as a bare array", async () => {
		const aryeo = standardScenario({
			"GET /orders": () => [order("o-a", 1050, "2026-11-02T14:00:00Z", [unscheduled("a-new", "2026-11-04T15:00:00Z")])],
		});
		const report = await runAutoConfirm(context(aryeo, new MemoryKV()));
		expect(byResult(report.outcomes, "confirmed")).toHaveLength(1);
	});

	it("when two new requests clash with each other, the older order wins", async () => {
		const aryeo = new FakeAryeo({
			"GET /orders": () => ({
				data: [
					order("o-new", 1061, "2026-11-02T14:30:00Z", [unscheduled("late", "2026-11-06T15:00:00Z", { duration: 60 })]),
					order("o-old", 1060, "2026-11-02T14:00:00Z", [unscheduled("early", "2026-11-06T15:30:00Z", { duration: 60 })]),
				],
			}),
			"GET /appointments": paged(appointmentBook([])),
			...orderDetailRoutes({ "o-new": { id: "o-new", number: 1061 }, "o-old": { id: "o-old", number: 1060 } }),
			"PUT /appointments/early/schedule": () => ({}),
			"PUT /appointments/late/schedule": () => ({}),
		});
		const report = await runAutoConfirm(context(aryeo, new MemoryKV()));
		expect(aryeo.writes().map((w) => w.path)).toEqual(["/appointments/early/schedule"]);
		const flagged = byResult(report.outcomes, "flagged")[0] as Extract<Outcome, { result: "flagged" }>;
		expect(flagged.entry.booking.order_number).toBe("1061");
		expect(flagged.entry.conflict_with?.order_number).toBe("1060");
	});

	it("retries next time when Aryeo has a temporary problem", async () => {
		const failing = standardScenario({
			"PUT /appointments/a-new/schedule": (call) => {
				throw new AryeoError(503, "PUT", call.path, "down");
			},
		});
		const kv = new MemoryKV();
		const first = await runAutoConfirm(context(failing, kv));
		expect(byResult(first.outcomes, "try_again_later")).toHaveLength(1);

		const working = standardScenario();
		await runAutoConfirm(context(working, kv));
		expect(working.writes().map((w) => w.path)).toEqual(["/appointments/a-new/schedule"]);
	});

	it("flags (and stops retrying) when Aryeo refuses the confirmation", async () => {
		const aryeo = standardScenario({
			"PUT /appointments/a-new/schedule": (call) => {
				throw new AryeoError(422, "PUT", call.path, { message: "Outside availability" });
			},
		});
		const report = await runAutoConfirm(context(aryeo, new MemoryKV()));
		const flagged = byResult(report.outcomes, "flagged") as Extract<Outcome, { result: "flagged" }>[];
		expect(flagged.find((f) => f.entry.booking.order_number === "1050")?.entry.reason).toMatch(/Aryeo refused.*Outside availability/);
	});

	it("uses the products' duration when the appointment has none, and flags when nothing has one", async () => {
		const aryeo = new FakeAryeo({
			"GET /orders": () => ({
				data: [
					order("o-x", 1070, "2026-11-02T14:00:00Z", [unscheduled("x", "2026-11-09T15:00:00Z", { duration: null })]),
					order("o-y", 1071, "2026-11-02T14:10:00Z", [unscheduled("y", "2026-11-10T15:00:00Z", { duration: null })]),
				],
			}),
			"GET /appointments": paged(appointmentBook([])),
			...orderDetailRoutes({
				"o-x": { id: "o-x", number: 1070, items: [{ product_variant: { duration: 45 } }] },
				"o-y": { id: "o-y", number: 1071, items: [{ title: "Floor plan" }] },
			}),
			"PUT /appointments/x/schedule": () => ({}),
		});
		const report = await runAutoConfirm(context(aryeo, new MemoryKV()));
		expect(aryeo.writes()).toEqual([
			{ method: "PUT", path: "/appointments/x/schedule", body: { start_at: "2026-11-09T15:00:00Z", end_at: "2026-11-09T15:45:00Z", notify_customer: false } },
		]);
		const flagged = byResult(report.outcomes, "flagged") as Extract<Outcome, { result: "flagged" }>[];
		expect(flagged[0].entry.reason).toMatch(/how long this shoot is/);
	});

	it("flags a day-only preference instead of guessing a time", async () => {
		const aryeo = standardScenario({
			"GET /orders": () => ({
				data: [order("o-a", 1050, "2026-11-02T14:00:00Z", [unscheduled("a-new", "2026-11-04T15:00:00Z", { preference_type: "DAY", preferred_start_at_time_of_day: "AFTERNOON" })])],
			}),
		});
		const report = await runAutoConfirm(context(aryeo, new MemoryKV()));
		expect(aryeo.writes()).toEqual([]);
		const flagged = byResult(report.outcomes, "flagged") as Extract<Outcome, { result: "flagged" }>[];
		expect(flagged[0].entry.reason).toMatch(/day preference \(afternoon\), not an exact time/);
	});

	it("doesn't confirm when the full appointment list can't be loaded", async () => {
		const aryeo = standardScenario({
			"GET /appointments": (call) => {
				throw new AryeoError(500, "GET", call.path, "boom");
			},
		});
		const report = await runAutoConfirm(context(aryeo, new MemoryKV()));
		expect(aryeo.writes()).toEqual([]);
		expect(byResult(report.outcomes, "try_again_later").length).toBeGreaterThan(0);
	});

	it("ignores canceled appointments when looking for clashes", async () => {
		const aryeo = standardScenario({
			"GET /appointments": paged(appointmentBook([{ id: "gone", status: "CANCELED", start_at: "2026-11-04T15:00:00Z", end_at: "2026-11-04T16:00:00Z" }])),
		});
		const report = await runAutoConfirm(context(aryeo, new MemoryKV()));
		expect(aryeo.writes().map((w) => w.path)).toContain("/appointments/a-new/schedule");
		expect(byResult(report.outcomes, "confirmed")).toHaveLength(1);
	});
});
