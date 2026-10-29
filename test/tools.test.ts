import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { StateStore } from "../src/store";
import { buildServer } from "../src/tools";
import { ADDRESS, FakeAryeo, MemoryKV, agreeingGeocoder, paged } from "./helpers";

const NOW = Date.parse("2026-11-02T15:00:00Z"); // Mon Nov 2, 10:00 AM EST

async function connect(aryeo: FakeAryeo, kv = new MemoryKV(), fetchFn = agreeingGeocoder(ADDRESS.latitude, ADDRESS.longitude)) {
	const server = buildServer({
		env: { ALLOWED_EMAIL: "ksremedia@gmail.com" } as Env,
		store: new StateStore(kv.asKV()),
		userEmail: "ksremedia@gmail.com",
		now: () => NOW,
		fetchFn,
		aryeo,
	});
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	const client = new Client({ name: "test", version: "1.0.0" });
	await client.connect(clientTransport);
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const result: any = await client.callTool({ name, arguments: args });
		return { text: result.content.map((c: any) => c.text).join("\n") as string, isError: Boolean(result.isError) };
	};
	return { client, call, kv };
}

const appointmentRecord = (id: string, status: string, start: string | null, end: string | null, orderRef = { id: "o-1", number: 1042 }) => ({
	id,
	status,
	start_at: start,
	end_at: end,
	order: orderRef,
});

function bookWith(...appointments: any[]) {
	return paged(appointments);
}

describe("tool list", () => {
	it("offers exactly the agreed tools, with read-only ones marked", async () => {
		const { client } = await connect(new FakeAryeo({}));
		const { tools } = await client.listTools();
		const names = tools.map((t) => t.name).sort();
		expect(names).toEqual(
			[
				"aryeo_lookup",
				"auto_confirm_status",
				"cancel_appointment",
				"confirm_appointment",
				"create_order",
				"get_order",
				"list_orders",
				"list_products",
				"list_upcoming_appointments",
				"mark_order_paid_offline",
				"preview_auto_confirm",
				"reschedule_appointment",
				"set_auto_confirm",
			].sort(),
		);
		expect(names.some((n) => /delete|refund|price|customer_edit|update_customer/.test(n))).toBe(false);
		const readOnly = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name).sort();
		expect(readOnly).toEqual(
			["aryeo_lookup", "auto_confirm_status", "get_order", "list_orders", "list_products", "list_upcoming_appointments", "preview_auto_confirm"].sort(),
		);
		expect(tools.find((t) => t.name === "cancel_appointment")?.annotations?.destructiveHint).toBe(true);
	});
});

describe("cancel_appointment", () => {
	const scenario = () => {
		let status = "SCHEDULED";
		return new FakeAryeo({
			"GET /appointments/ap-1": () => ({ data: appointmentRecord("ap-1", status, "2026-11-04T15:00:00Z", "2026-11-04T16:00:00Z") }),
			"PUT /appointments/ap-1/cancel": () => {
				status = "CANCELED";
				return {};
			},
		});
	};

	it("sends {} unless notifying was asked for, and checks the result", async () => {
		const aryeo = scenario();
		const { call } = await connect(aryeo);
		const result = await call("cancel_appointment", { appointment_id: "ap-1" });
		expect(aryeo.writes()).toEqual([{ method: "PUT", path: "/appointments/ap-1/cancel", body: {} }]);
		expect(result.text).toContain("The client was not notified.");
		expect(result.text).toContain("status is now CANCELED");
		expect(aryeo.log.at(-1)).toMatchObject({ method: "GET", path: "/appointments/ap-1" });
	});

	it("includes notify_customer: true only when asked", async () => {
		const aryeo = scenario();
		const { call } = await connect(aryeo);
		await call("cancel_appointment", { appointment_id: "ap-1", notify_customer: true });
		expect(aryeo.writes()[0].body).toEqual({ notify_customer: true });
	});

	it("leaves order #1005 alone", async () => {
		const aryeo = new FakeAryeo({
			"GET /appointments/ap-t": () => ({ data: appointmentRecord("ap-t", "SCHEDULED", "2026-11-04T15:00:00Z", null, { id: "o-t", number: 1005 }) }),
		});
		const { call } = await connect(aryeo);
		const result = await call("cancel_appointment", { appointment_id: "ap-t" });
		expect(result.isError).toBe(true);
		expect(aryeo.writes()).toEqual([]);
	});
});

describe("reschedule_appointment", () => {
	const scenario = (others: any[] = []) => {
		let current = appointmentRecord("ap-1", "SCHEDULED", "2026-11-04T15:00:00Z", "2026-11-04T16:30:00Z");
		return new FakeAryeo({
			"GET /appointments/ap-1": () => ({ data: current }),
			"GET /appointments": bookWith(current, ...others),
			"PUT /appointments/ap-1/reschedule": (c: any) => {
				current = { ...current, start_at: c.body.start_at, end_at: c.body.end_at };
				return {};
			},
		});
	};

	it("keeps the length, reads New York time, and doesn't notify by default", async () => {
		const aryeo = scenario();
		const { call } = await connect(aryeo);
		const result = await call("reschedule_appointment", { appointment_id: "ap-1", start_at: "2026-11-06T09:00" });
		expect(aryeo.writes()).toEqual([
			{ method: "PUT", path: "/appointments/ap-1/reschedule", body: { start_at: "2026-11-06T14:00:00Z", end_at: "2026-11-06T15:30:00Z" } },
		]);
		expect(result.text).toContain("the new time is saved");
	});

	it("puts notify_customer: true in the same call when asked", async () => {
		const aryeo = scenario();
		const { call } = await connect(aryeo);
		await call("reschedule_appointment", { appointment_id: "ap-1", start_at: "2026-11-06T09:00", notify_customer: true });
		expect(aryeo.writes()[0].body).toMatchObject({ notify_customer: true });
	});

	it("refuses the past and clashes", async () => {
		const clash = appointmentRecord("ap-2", "SCHEDULED", "2026-11-06T14:30:00Z", "2026-11-06T15:30:00Z", { id: "o-2", number: 1043 });
		const aryeo = scenario([clash]);
		const { call } = await connect(aryeo);
		const past = await call("reschedule_appointment", { appointment_id: "ap-1", start_at: "2026-11-01T09:00" });
		expect(past.isError).toBe(true);
		const clashing = await call("reschedule_appointment", { appointment_id: "ap-1", start_at: "2026-11-06T09:00" });
		expect(clashing.isError).toBe(true);
		expect(clashing.text).toContain("order #1043");
		expect(aryeo.writes()).toEqual([]);
	});
});

describe("create_order", () => {
	const scenario = (address: any = ADDRESS, others: any[] = []) =>
		new FakeAryeo({
			"GET /addresses/addr-1": () => ({ data: address }),
			"GET /appointments": bookWith(...others),
			"POST /orders": () => ({ data: { id: "o-new", number: 1080 } }),
			"POST /order-items": () => ({ data: { id: "item-1" } }),
			"POST /appointments/store": () => ({ data: { id: "ap-new" } }),
		});

	const args = { customer_id: "cust-1", address_id: "addr-1", product_variant_id: "var-1", start_at: "2026-11-10T10:00", duration_minutes: 90 };

	it("makes the three calls in order with the agreed bodies", async () => {
		const aryeo = scenario();
		const { call } = await connect(aryeo);
		const result = await call("create_order", args);
		expect(result.isError).toBe(false);
		expect(aryeo.writes()).toEqual([
			{ method: "POST", path: "/orders", body: { customer_id: "cust-1", address_id: "addr-1", notify: false } },
			{ method: "POST", path: "/order-items", body: { order_id: "o-new", product_variant_id: "var-1", quantity: 1 } },
			{ method: "POST", path: "/appointments/store", body: { order_id: "o-new", start_at: "2026-11-10T15:00:00Z", end_at: "2026-11-10T16:30:00Z" } },
		]);
	});

	it("stops before creating anything when the address is incomplete", async () => {
		const aryeo = scenario({ ...ADDRESS, street_number: "" });
		const { call } = await connect(aryeo);
		const result = await call("create_order", args);
		expect(result.isError).toBe(true);
		expect(result.text).toContain("street number is empty");
		expect(aryeo.writes()).toEqual([]);
	});

	it("stops when Aryeo's pin is far from the independent geocode", async () => {
		const aryeo = scenario();
		const { call } = await connect(aryeo, new MemoryKV(), agreeingGeocoder(41.5, -72.5)); // ~48 km away
		const result = await call("create_order", args);
		expect(result.isError).toBe(true);
		expect(result.text).toContain("The pin may be wrong");
		expect(aryeo.writes()).toEqual([]);
	});

	it("stops on a clash", async () => {
		const clash = appointmentRecord("ap-2", "SCHEDULED", "2026-11-10T15:30:00Z", "2026-11-10T16:00:00Z", { id: "o-2", number: 1043 });
		const aryeo = scenario(ADDRESS, [clash]);
		const { call } = await connect(aryeo);
		const result = await call("create_order", args);
		expect(result.isError).toBe(true);
		expect(aryeo.writes()).toEqual([]);
	});
});

describe("mark_order_paid_offline", () => {
	const scenario = () =>
		new FakeAryeo({
			"GET /orders": () => ({ data: [{ id: "o-1", number: 1042 }], meta: { last_page: 1 } }),
			"GET /orders/o-1": () => ({ data: { id: "o-1", number: 1042, total_amount: 30000, payment_status: "UNPAID" } }),
			"POST /orders/o-1/payments": () => ({}),
		});

	it("records a check in cents, USD, dated today in New York", async () => {
		const aryeo = scenario();
		const { call } = await connect(aryeo);
		await call("mark_order_paid_offline", { order: "1042", amount_dollars: 275.5 });
		expect(aryeo.writes()).toEqual([
			{ method: "POST", path: "/orders/o-1/payments", body: { amount: 27550, currency: "USD", collection_source: "CHECK", date: "2026-11-02" } },
		]);
	});

	it("refuses more than the order total", async () => {
		const aryeo = scenario();
		const { call } = await connect(aryeo);
		const result = await call("mark_order_paid_offline", { order: "1042", amount_dollars: 400 });
		expect(result.isError).toBe(true);
		expect(aryeo.writes()).toEqual([]);
	});
});

describe("the on/off switch and preview", () => {
	it("starts OFF, and switching it is recorded", async () => {
		const { call, kv } = await connect(new FakeAryeo({}));
		expect((await call("auto_confirm_status")).text).toContain("Auto-confirm check is OFF");
		await call("set_auto_confirm", { on: true });
		expect(await new StateStore(kv.asKV()).isAutoConfirmOn()).toBe(true);
		expect((await call("auto_confirm_status")).text).toMatch(/is ON \(switched on .* by ksremedia@gmail.com\)/);
	});

	it("preview never writes", async () => {
		const aryeo = new FakeAryeo({
			"GET /orders": () => ({
				data: [{ id: "o-a", number: 1050, created_at: "2026-11-02T14:00:00Z", appointments: [{ id: "a", status: "UNSCHEDULED", preferred_start_at: "2026-11-04T15:00:00Z", duration: 60 }] }],
			}),
			"GET /orders/o-a": () => ({ data: { id: "o-a", number: 1050, address: ADDRESS, customer: { name: "Pat" } } }),
			"GET /appointments": bookWith(),
		});
		const { call, kv } = await connect(aryeo);
		const result = await call("preview_auto_confirm");
		expect(result.text).toContain("WOULD CONFIRM: order #1050, 12 Harbor Lane, Mystic, CT 06355, client Pat");
		expect(aryeo.writes()).toEqual([]);
		expect(kv.writes).toBe(0);
	});
});

describe("confirm_appointment", () => {
	it("won't touch order #1005", async () => {
		const aryeo = new FakeAryeo({
			"GET /appointments/a": () => ({ data: { id: "a", status: "UNSCHEDULED", preferred_start_at: "2026-11-04T15:00:00Z", duration: 60, order: { id: "o-t", number: 1005 } } }),
		});
		const { call } = await connect(aryeo);
		const result = await call("confirm_appointment", { appointment_id: "a" });
		expect(result.isError).toBe(true);
		expect(result.text).toContain("test record");
		expect(aryeo.writes()).toEqual([]);
	});
});

describe("aryeo_lookup", () => {
	it("only does GETs on clean paths", async () => {
		const aryeo = new FakeAryeo({ "GET /customers": () => ({ data: [] }) });
		const { call } = await connect(aryeo);
		expect((await call("aryeo_lookup", { path: "/customers" })).isError).toBe(false);
		expect((await call("aryeo_lookup", { path: "/orders/../orders" })).isError).toBe(true);
		expect((await call("aryeo_lookup", { path: "https://evil.example/x" })).isError).toBe(true);
		expect(aryeo.writes()).toEqual([]);
	});
});

describe("review follow-ups", () => {
	it("re-checking an already-flagged booking doesn't flag it a second time", async () => {
		const appointment = { id: "a", status: "UNSCHEDULED", preferred_start_at: "2026-11-01T15:00:00Z", duration: 60, order: { id: "o-a", number: 1050 } };
		const aryeo = new FakeAryeo({
			"GET /appointments/a": () => ({ data: appointment }),
			"GET /orders/o-a": () => ({ data: { id: "o-a", number: 1050, address: ADDRESS, customer: { name: "Pat" } } }),
		});
		const { call, kv } = await connect(aryeo);
		const first = await call("confirm_appointment", { appointment_id: "a" });
		expect(first.text).toContain("FLAGGED");
		const second = await call("confirm_appointment", { appointment_id: "a" });
		expect(second.isError).toBe(true);
		expect(second.text).toContain("already flagged");
		expect((await new StateStore(kv.asKV()).listActivity(10)).length).toBe(1);
		expect(aryeo.writes()).toEqual([]);
	});

	it("refuses to record the same payment twice in a day unless told to", async () => {
		const aryeo = new FakeAryeo({
			"GET /orders": () => ({ data: [{ id: "o-1", number: 1042 }], meta: { last_page: 1 } }),
			"GET /orders/o-1": () => ({ data: { id: "o-1", number: 1042, total_amount: 30000 } }),
			"POST /orders/o-1/payments": () => ({}),
		});
		const { call } = await connect(aryeo);
		await call("mark_order_paid_offline", { order: "1042", amount_dollars: 100 });
		const again = await call("mark_order_paid_offline", { order: "1042", amount_dollars: 100 });
		expect(again.isError).toBe(true);
		expect(aryeo.writes()).toHaveLength(1);
		await call("mark_order_paid_offline", { order: "1042", amount_dollars: 100, record_again: true });
		expect(aryeo.writes()).toHaveLength(2);
	});

	it("won't record a payment on order #1005", async () => {
		const aryeo = new FakeAryeo({
			"GET /orders": () => ({ data: [{ id: "o-t", number: 1005 }], meta: { last_page: 1 } }),
			"GET /orders/o-t": () => ({ data: { id: "o-t", number: 1005, total_amount: 30000 } }),
		});
		const { call } = await connect(aryeo);
		expect((await call("mark_order_paid_offline", { order: "1005", amount_dollars: 10 })).isError).toBe(true);
		expect(aryeo.writes()).toEqual([]);
	});

	it("refuses to book over an appointment whose time it can't read", async () => {
		const aryeo = new FakeAryeo({
			"GET /addresses/addr-1": () => ({ data: ADDRESS }),
			"GET /appointments": bookWith({ id: "x", status: "SCHEDULED", start_at: "2026-11-10 10:00", end_at: null }),
		});
		const { call } = await connect(aryeo);
		const result = await call("create_order", {
			customer_id: "c",
			address_id: "addr-1",
			product_variant_id: "v",
			start_at: "2026-11-10T10:00",
			duration_minutes: 60,
		});
		expect(result.isError).toBe(true);
		expect(result.text).toContain("no readable time");
		expect(aryeo.writes()).toEqual([]);
	});
});
