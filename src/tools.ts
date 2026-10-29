// The tools Claude sees. Read tools never change anything. Write tools only
// touch bookings, orders and payments in the ways listed below; there is no
// code here for deleting orders, refunds, price edits or customer edits.

import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
	type AryeoClient,
	AryeoError,
	IGNORED_ORDER_NUMBERS,
	asList,
	asObject,
	createAryeoClient,
	findAppointment,
	getAllPages,
	getOrderWithIncludes,
	listAllAppointments,
	resolveOrderId,
	safeId,
} from "./aryeo";
import {
	type Outcome,
	blocksItsSlot,
	bookingKey,
	evaluateAppointment,
	newRunState,
	occupiedWindow,
	runAutoConfirm,
} from "./autoconfirm";
import {
	appointmentOrderId,
	appointmentWindow,
	money,
	orderAddressObject,
	orderNumber,
	overlaps,
	parseAryeoTime,
	positiveNumber,
	summarizeAppointment,
	summarizeOrder,
	text,
	upper,
} from "./format";
import { checkAddress } from "./geocode";
import type { ActivityEntry, PartySummary, StateStore } from "./store";
import { easternDate, formatEastern, isWithinCheckHours, parseTimeInput, toIso } from "./time";

export interface ToolDeps {
	env: Env;
	store: StateStore;
	userEmail: string;
	now?: () => number;
	fetchFn?: typeof fetch;
	/** Tests pass a fake client; production builds one from the ARYEO_API_KEY secret. */
	aryeo?: AryeoClient;
}

const MAX_OUTPUT_CHARS = 100_000;

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function reply(summary: string, data?: unknown): ToolResult {
	let body = summary;
	if (data !== undefined) {
		let json = JSON.stringify(data, null, 2);
		if (json.length > MAX_OUTPUT_CHARS) json = `${json.slice(0, MAX_OUTPUT_CHARS)}\n… (cut off: too long to show in full)`;
		body += `\n\n${json}`;
	}
	return { content: [{ type: "text", text: body }] };
}

function failure(message: string): ToolResult {
	return { content: [{ type: "text", text: message }], isError: true };
}

function describeError(error: unknown): string {
	if (error instanceof AryeoError) return error.message;
	return error instanceof Error ? error.message : String(error);
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await fn(items[index]);
		}
	});
	await Promise.all(workers);
	return results;
}

function describeParty(p: PartySummary): string {
	return `order #${p.order_number}, ${p.address}, client ${p.client}, ${p.time}`;
}

export function describeOutcome(outcome: Outcome): string {
	switch (outcome.result) {
		case "confirmed": {
			const e = outcome.entry;
			const notes = e.notes?.length ? `\n   Notes: ${e.notes.join(" ")}` : "";
			return `${outcome.dryRun ? "WOULD CONFIRM" : "CONFIRMED"}: ${describeParty(e.booking)}${notes}`;
		}
		case "flagged": {
			const e = outcome.entry;
			const clash = e.conflict_with ? `\n   Clashes with ${describeParty(e.conflict_with)}` : "";
			return `${outcome.dryRun ? "WOULD FLAG" : "FLAGGED"}: ${describeParty(e.booking)}\n   ${e.reason}${clash}`;
		}
		case "already_handled":
			return `Already handled earlier (order #${outcome.order_number}, appointment ${outcome.appointment_id}): ${outcome.previously}`;
		case "try_again_later":
			return `Not done yet, will retry (order #${outcome.order_number}): ${outcome.problem}`;
		case "not_eligible":
			return `Skipped (order #${outcome.order_number}): ${outcome.reason}`;
	}
}

function describeActivity(entry: ActivityEntry): string {
	const who = entry.source === "claude" ? " (via Claude)" : "";
	const head = `${formatEastern(entry.at)}: ${entry.kind.toUpperCase()}${who}: ${describeParty(entry.booking)}`;
	const reason = entry.kind === "flagged" ? `\n   ${entry.reason}` : "";
	const clash = entry.conflict_with ? `\n   Clashes with ${describeParty(entry.conflict_with)}` : "";
	return head + reason + clash;
}

function readTime(value: string, label: string): number {
	const ms = parseTimeInput(value);
	if (Number.isNaN(ms)) {
		throw new Error(`${label} "${value}" isn't a time I can read. Use 2026-11-03T10:00 (New York time) or a full ISO time with a zone.`);
	}
	return ms;
}

function endTime(start: number, endAt: string | undefined, durationMinutes: number | undefined, fallbackMinutes?: number | null): number {
	if (endAt) return readTime(endAt, "end_at");
	const minutes = durationMinutes ?? fallbackMinutes;
	if (!minutes) throw new Error("Give either end_at or duration_minutes so I know when the shoot ends.");
	return start + minutes * 60_000;
}

/** Same clash rules as the auto-confirm check: anything unreadable stops us rather than being skipped. */
async function findClash(aryeo: AryeoClient, window: { start: number; end: number }, ignoreId?: string): Promise<any | null> {
	const all = await listAllAppointments(aryeo);
	if (!all.complete) throw new Error("There are too many appointments to check them all for clashes, so I stopped.");
	const others = all.items.filter((other) => blocksItsSlot(other) && !(ignoreId && text(other?.id) === ignoreId));
	const unreadable = others.filter((other) => occupiedWindow(other) === null);
	if (unreadable.length) {
		throw new Error(`${unreadable.length} scheduled appointment(s) in Aryeo have no readable time, so clashes can't be ruled out. Nothing was changed.`);
	}
	return others.find((other) => overlaps(window, occupiedWindow(other)!)) ?? null;
}

function describeClash(clash: any): string {
	const s = summarizeAppointment(clash);
	return `It overlaps ${s.order_number ? `order #${s.order_number}` : `appointment ${s.id}`} (${s.when}${s.title ? `, "${s.title}"` : ""}).`;
}

async function appointmentOrder(aryeo: AryeoClient, appointment: any): Promise<any> {
	const orderId = appointmentOrderId(appointment);
	if (appointment?.order?.number !== undefined && appointment?.order?.id) return appointment.order;
	if (!orderId) return appointment?.order ?? {};
	const { order } = await getOrderWithIncludes(aryeo, orderId, []);
	return order;
}

export function buildServer(deps: ToolDeps): McpServer {
	const now = deps.now ?? (() => Date.now());
	const server = new McpServer({ name: "Horizon Home Media Aryeo", version: "1.0.0" });

	const aryeo = (): AryeoClient => {
		if (deps.aryeo) return deps.aryeo;
		if (!deps.env.ARYEO_API_KEY) throw new Error("The ARYEO_API_KEY secret isn't set in Cloudflare yet, so I can't reach Aryeo.");
		return createAryeoClient(deps.env.ARYEO_API_KEY, { baseUrl: deps.env.ARYEO_BASE_URL });
	};

	const guarded =
		<A>(fn: (args: A) => Promise<ToolResult>) =>
		async (args: A): Promise<ToolResult> => {
			try {
				return await fn(args);
			} catch (error) {
				return failure(describeError(error));
			}
		};

	const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

	// ---------------------------------------------------------------- read tools

	server.registerTool(
		"list_orders",
		{
			title: "List new and upcoming orders",
			description:
				"Lists the newest Aryeo orders (newest first) with their appointments, client and address. Set only_upcoming to keep orders that have an unscheduled appointment or one still to come. Order #1005 is an old test record and is marked as such.",
			inputSchema: z.object({
				count: z.number().int().min(1).max(50).default(10).describe("How many orders per page (1-50)."),
				page: z.number().int().min(1).default(1),
				only_upcoming: z.boolean().default(false),
			}),
			annotations: read,
		},
		guarded(async ({ count, page, only_upcoming }) => {
			const client = aryeo();
			const orders = asList(await client.get("/orders", { per_page: count, page, sort: "-created_at", include: "appointments" }));
			const detailed = await mapLimit(orders, 4, async (order) => {
				const missing = [!orderAddressObject(order) ? "address" : "", !order?.customer ? "customer" : ""].filter(Boolean);
				if (!missing.length || !order?.id) return order;
				try {
					const { order: extra } = await getOrderWithIncludes(client, order.id, missing);
					return { ...order, address: orderAddressObject(order) ?? extra.address, customer: order.customer ?? extra.customer };
				} catch {
					return order;
				}
			});
			const nowMs = now();
			let summaries = detailed.map((order) => summarizeOrder(order, IGNORED_ORDER_NUMBERS.has(orderNumber(order))));
			if (only_upcoming) {
				summaries = summaries.filter((order) =>
					order.appointments.some(
						(a) => a.status === "UNSCHEDULED" || (a.status !== "CANCELED" && a.start_at !== null && Date.parse(a.start_at) >= nowMs),
					),
				);
			}
			return reply(`${summaries.length} order(s) on page ${page}. Times are New York time.`, summaries);
		}),
	);

	server.registerTool(
		"get_order",
		{
			title: "Get one order's full details",
			description:
				"Full details for one order: client, address (with a map-pin check), products, appointments, payment status. Accepts an order number like 1042 or the order's ID.",
			inputSchema: z.object({ order: z.string().min(1).describe("Order number (e.g. 1042) or order ID.") }),
			annotations: read,
		},
		guarded(async ({ order }) => {
			const client = aryeo();
			const id = await resolveOrderId(client, order);
			const { order: full, skippedIncludes } = await getOrderWithIncludes(client, id, ["appointments", "items", "address", "customer"]);
			const addressCheck = await checkAddress(orderAddressObject(full), deps.fetchFn);
			const summary = summarizeOrder(full, IGNORED_ORDER_NUMBERS.has(orderNumber(full)));
			const notes = skippedIncludes.length ? `\n(Aryeo didn't return: ${skippedIncludes.join(", ")}.)` : "";
			const addressLine = addressCheck.ok ? "Address check: looks right." : `Address check: ${addressCheck.problems.join(" ")}`;
			return reply(`Order #${summary.number}. ${addressLine}${notes}`, { summary, address_check: addressCheck, full_record: full });
		}),
	);

	server.registerTool(
		"list_upcoming_appointments",
		{
			title: "List upcoming appointments",
			description:
				"Every upcoming appointment, found by paging through all appointments in Aryeo: scheduled shoots that haven't ended yet, plus (by default) unscheduled requests with the client's preferred time. Canceled ones are left out.",
			inputSchema: z.object({
				include_unscheduled: z.boolean().default(true),
				days_ahead: z.number().int().min(1).max(730).optional().describe("Only show the next N days."),
			}),
			annotations: read,
		},
		guarded(async ({ include_unscheduled, days_ahead }) => {
			const all = await listAllAppointments(aryeo());
			const nowMs = now();
			const limit = days_ahead ? nowMs + days_ahead * 86_400_000 : Number.POSITIVE_INFINITY;
			const rows = all.items
				.map((appointment) => {
					const status = upper(appointment?.status);
					const window = appointmentWindow(appointment);
					const preferred = parseAryeoTime(appointment?.preferred_start_at);
					let sortKey: number | null = null;
					if (status === "SCHEDULED" && window && window.end >= nowMs) sortKey = window.start;
					else if (include_unscheduled && status === "UNSCHEDULED") sortKey = Number.isNaN(preferred) ? nowMs : preferred;
					return sortKey === null || sortKey > limit ? null : { sortKey, appointment };
				})
				.filter((row): row is { sortKey: number; appointment: any } => row !== null)
				.sort((a, b) => a.sortKey - b.sortKey)
				.map((row) => summarizeAppointment(row.appointment));
			const warning = all.complete ? "" : " Warning: stopped at the page limit, so this list may be missing some.";
			return reply(`${rows.length} upcoming appointment(s), from ${all.items.length} in Aryeo. Times are New York time.${warning}`, rows);
		}),
	);

	server.registerTool(
		"list_products",
		{
			title: "List products",
			description: "Lists Aryeo products and their variants (IDs, prices, durations). Use it to find the product_variant_id for create_order.",
			inputSchema: z.object({}),
			annotations: read,
		},
		guarded(async () => {
			const client = aryeo();
			let products;
			try {
				products = await getAllPages(client, "/products", { include: "variants" });
			} catch (error) {
				if (!(error instanceof AryeoError) || error.status !== 400) throw error;
				products = await getAllPages(client, "/products");
			}
			const rows = products.items.map((product) => ({
				id: text(product?.id),
				title: text(product?.title),
				variants: (Array.isArray(product?.variants) ? product.variants : []).map((variant: any) => ({
					id: text(variant?.id),
					title: text(variant?.title),
					price: money(variant?.price),
					duration_minutes: positiveNumber(variant?.duration),
				})),
			}));
			return reply(`${rows.length} product(s).`, rows);
		}),
	);

	server.registerTool(
		"aryeo_lookup",
		{
			title: "Look something up in Aryeo (read-only)",
			description:
				"Read-only GET of any Aryeo API path under /v1, for things the other tools don't cover (for example /customers or /addresses/{id}). Never changes anything.",
			inputSchema: z.object({
				path: z.string().describe("API path starting with /, e.g. /customers or /addresses/abc-123."),
				query: z.record(z.string(), z.string()).optional().describe("Query parameters, e.g. {\"per_page\": \"25\"}."),
			}),
			annotations: read,
		},
		guarded(async ({ path, query }) => {
			const clean = path.trim().replace(/^\/?v1(?=\/)/, "");
			if (!/^\/[A-Za-z0-9_\-/]*$/.test(clean) || clean.includes("//") || clean.includes("..")) {
				return failure("That path isn't allowed. Use something like /customers or /orders/{id}.");
			}
			return reply(`GET ${clean}`, await aryeo().get(clean, query));
		}),
	);

	// ------------------------------------------------- auto-confirm check tools

	server.registerTool(
		"auto_confirm_status",
		{
			title: "Auto-confirm check: status and activity",
			description:
				"Whether the 5-minute auto-confirm check is switched on, when it last ran, and what it recently confirmed or flagged (flags need manual review).",
			inputSchema: z.object({ activity_limit: z.number().int().min(1).max(100).default(20) }),
			annotations: { ...read, openWorldHint: false },
		},
		guarded(async ({ activity_limit }) => {
			const [on, history, lastRun, activity] = await Promise.all([
				deps.store.isAutoConfirmOn(),
				deps.store.switchHistory(),
				deps.store.getLastRun(),
				deps.store.listActivity(activity_limit),
			]);
			const nowMs = now();
			const lines = [
				`Auto-confirm check is ${on ? "ON" : "OFF"}${history ? ` (switched ${history.on ? "on" : "off"} ${formatEastern(history.at)} by ${history.by})` : ""}.`,
				`It runs every 5 minutes from 7:00 AM to 9:00 PM New York time. Right now it's ${formatEastern(nowMs)}, ${isWithinCheckHours(nowMs) ? "inside" : "outside"} those hours.`,
				lastRun
					? `Last run: ${formatEastern(lastRun.at)}: ${lastRun.orders_checked} orders checked, ${lastRun.confirmed} confirmed, ${lastRun.flagged} flagged${lastRun.errors.length ? `, problems: ${lastRun.errors.join("; ")}` : ""}.`
					: "It hasn't run yet.",
				"",
				activity.length ? `Recent activity (newest first):\n${activity.map(describeActivity).join("\n")}` : "No confirmations or flags yet.",
			];
			return reply(lines.join("\n"));
		}),
	);

	server.registerTool(
		"preview_auto_confirm",
		{
			title: "Preview the auto-confirm check (changes nothing)",
			description:
				"Runs the auto-confirm rules against the 10 newest orders right now and shows what the check WOULD confirm or flag. It never confirms anything, never writes to Aryeo, and doesn't mark anything as handled. Works whether the check is on or off.",
			inputSchema: z.object({}),
			annotations: read,
		},
		guarded(async () => {
			const report = await runAutoConfirm({
				aryeo: aryeo(),
				store: deps.store,
				now: now(),
				dryRun: true,
				source: "auto-check",
				fetchFn: deps.fetchFn,
			});
			const lines = [
				`Preview at ${report.eastern_time}. Nothing was changed.`,
				`${report.orders_checked} newest orders checked, ${report.candidates} unscheduled booking(s) with a preferred time.`,
				...report.outcomes.map(describeOutcome),
				...report.errors.map((error) => `Problem: ${error}`),
			];
			return reply(lines.join("\n"), { aryeo_calls: report.aryeo_calls });
		}),
	);

	server.registerTool(
		"set_auto_confirm",
		{
			title: "Turn the auto-confirm check on or off",
			description:
				"Switches the 5-minute auto-confirm check on or off. Only switch it on when the owner explicitly asks, and only after their old auto-confirm system is off, so bookings aren't confirmed twice.",
			inputSchema: z.object({ on: z.boolean().describe("true = on, false = off") }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		guarded(async ({ on }) => {
			await deps.store.setAutoConfirm(on, deps.userEmail, now());
			return reply(
				on
					? "The auto-confirm check is now ON. It acts every 5 minutes between 7:00 AM and 9:00 PM New York time. Make sure the old auto-confirm system is off."
					: "The auto-confirm check is now OFF. It will keep waking up every 5 minutes but won't look at or change anything.",
			);
		}),
	);

	// --------------------------------------------------------------- write tools

	server.registerTool(
		"confirm_appointment",
		{
			title: "Confirm a booked appointment",
			description:
				"Confirms one UNSCHEDULED appointment at the client's preferred time, using exactly the auto-confirm rules: the end time is the preferred time plus the shoot length; it refuses if the time is in the past, if it overlaps any scheduled appointment, or if it's order #1005. Never notifies the client.",
			inputSchema: z.object({ appointment_id: z.string().min(1) }),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		},
		guarded(async ({ appointment_id }) => {
			const client = aryeo();
			const appointment = await findAppointment(client, appointment_id);
			if (!appointment) return failure(`Couldn't find appointment ${appointment_id} in Aryeo.`);
			const order = await appointmentOrder(client, appointment);
			const nowMs = now();
			const context = { aryeo: client, store: deps.store, now: nowMs, dryRun: false, source: "claude" as const, fetchFn: deps.fetchFn };

			// Already flagged earlier? Re-check without recording anything, so it isn't flagged a second time.
			const previous = await deps.store.getHandled(bookingKey(appointment));
			if (previous) {
				const recheck = await evaluateAppointment({ ...context, dryRun: true }, newRunState(), order, appointment, { respectHandled: false });
				if (recheck.result !== "confirmed") {
					return failure(
						`This booking was already ${previous.kind} on ${formatEastern(previous.at)} (${previous.reason}). It still can't be confirmed:\n${describeOutcome(recheck)}`,
					);
				}
			}

			if (!(await deps.store.tryLock(nowMs, "claude"))) {
				return failure("The auto-confirm check is running right now. Try again in a minute.");
			}
			try {
				const outcome = await evaluateAppointment(context, newRunState(), order, appointment, { respectHandled: false });
				const result = reply(describeOutcome(outcome));
				if (outcome.result !== "confirmed") result.isError = outcome.result !== "flagged";
				return result;
			} finally {
				await deps.store.unlock();
			}
		}),
	);

	server.registerTool(
		"create_order",
		{
			title: "Create an order with one product and an appointment",
			description:
				"Creates an order for an existing customer and address, adds one product variant (quantity 1), and books an appointment. Checks first that the address has a street number and name and that its map pin matches an independent geocode, and that the time is in the future and doesn't overlap a scheduled appointment. Times without a zone are New York time. Set notify_customer only if the owner explicitly asks for the client to be notified. Find IDs with get_order (customer and address of a past order), list_products, or aryeo_lookup.",
			inputSchema: z.object({
				customer_id: z.string().min(1),
				address_id: z.string().min(1),
				product_variant_id: z.string().min(1),
				start_at: z.string().describe("e.g. 2026-11-03T10:00 (New York time)"),
				end_at: z.string().optional(),
				duration_minutes: z.number().int().min(5).max(24 * 60).optional(),
				notify_customer: z.boolean().default(false).describe("Only true if the owner explicitly asked to notify the client."),
				allow_overlap: z.boolean().default(false).describe("Only true if the owner explicitly said to book over a clash."),
				address_override: z
					.boolean()
					.default(false)
					.describe("Only true if the owner explicitly confirmed the address and map pin are right despite a failed address check."),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		},
		guarded(async (args) => {
			const client = aryeo();
			const customerId = safeId(args.customer_id, "customer ID");
			const addressId = safeId(args.address_id, "address ID");
			const variantId = safeId(args.product_variant_id, "product variant ID");
			const start = readTime(args.start_at, "start_at");
			const end = endTime(start, args.end_at, args.duration_minutes);
			if (start <= now()) return failure(`${formatEastern(start)} is in the past.`);
			if (end <= start) return failure("The end time has to be after the start time.");

			let address: any = null;
			let addressProblem = "";
			try {
				address = asObject(await client.get(`/addresses/${addressId}`));
			} catch (error) {
				addressProblem = `Couldn't look up address ${addressId}: ${describeError(error)}`;
			}
			const addressCheck = address ? await checkAddress(address, deps.fetchFn) : null;
			const problems = addressCheck ? addressCheck.problems : [addressProblem];
			if (problems.length && !args.address_override) {
				return failure(`Stopped before creating anything. Address check: ${problems.join(" ")}`);
			}

			const clash = await findClash(client, { start, end });
			if (clash && !args.allow_overlap) return failure(`Stopped before creating anything. ${describeClash(clash)}`);

			const steps: string[] = [];
			const created = asObject(
				await client.post("/orders", { customer_id: customerId, address_id: addressId, notify: args.notify_customer === true }),
			);
			const orderId = text(created?.id);
			if (!orderId) return failure(`Aryeo didn't return the new order's ID. Response: ${JSON.stringify(created).slice(0, 500)}`);
			steps.push(`1. Created order #${orderNumber(created)} (${orderId}).`);
			try {
				await client.post("/order-items", { order_id: orderId, product_variant_id: variantId, quantity: 1 });
				steps.push("2. Added the product.");
				const appointment = asObject(await client.post("/appointments/store", { order_id: orderId, start_at: toIso(start), end_at: toIso(end) }));
				steps.push(`3. Booked the appointment for ${formatEastern(start)} to ${formatEastern(end)}${appointment?.id ? ` (appointment ${appointment.id})` : ""}.`);
			} catch (error) {
				steps.push(`Stopped: ${describeError(error)}`);
				steps.push(`The order exists but is incomplete. Finish it in Aryeo (nothing was deleted).`);
				return { ...reply(steps.join("\n")), isError: true };
			}
			if (problems.length) steps.push(`Note: created despite the address check, as you asked: ${problems.join(" ")}`);
			if (clash) steps.push(`Note: booked over a clash, as you asked. ${describeClash(clash)}`);
			return reply(steps.join("\n"));
		}),
	);

	server.registerTool(
		"reschedule_appointment",
		{
			title: "Reschedule an appointment",
			description:
				"Moves an appointment to a new time, then reads it back from Aryeo to confirm. Refuses times in the past and clashes with other scheduled appointments. Keeps the current length unless end_at or duration_minutes is given. Times without a zone are New York time. Set notify_customer only if the owner explicitly asks; it can't be sent later.",
			inputSchema: z.object({
				appointment_id: z.string().min(1),
				start_at: z.string().describe("e.g. 2026-11-03T10:00 (New York time)"),
				end_at: z.string().optional(),
				duration_minutes: z.number().int().min(5).max(24 * 60).optional(),
				notify_customer: z.boolean().default(false).describe("Only true if the owner explicitly asked to notify the client."),
				allow_overlap: z.boolean().default(false).describe("Only true if the owner explicitly said to book over a clash."),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
		},
		guarded(async (args) => {
			const client = aryeo();
			const id = safeId(args.appointment_id, "appointment ID");
			const current = await findAppointment(client, id);
			if (!current) return failure(`Couldn't find appointment ${id} in Aryeo.`);
			const order = await appointmentOrder(client, current);
			if (IGNORED_ORDER_NUMBERS.has(orderNumber(order))) return failure(`Order #${orderNumber(order)} is the old test record; leaving it alone.`);
			const currentWindow = appointmentWindow(current);
			const currentMinutes = currentWindow ? (currentWindow.end - currentWindow.start) / 60_000 : positiveNumber(current?.duration);
			const start = readTime(args.start_at, "start_at");
			const end = endTime(start, args.end_at, args.duration_minutes, currentMinutes);
			if (start <= now()) return failure(`${formatEastern(start)} is in the past.`);
			if (end <= start) return failure("The end time has to be after the start time.");
			const clash = await findClash(client, { start, end }, id);
			if (clash && !args.allow_overlap) return failure(`Didn't reschedule. ${describeClash(clash)}`);

			const body: Record<string, unknown> = { start_at: toIso(start), end_at: toIso(end) };
			if (args.notify_customer === true) body.notify_customer = true;
			await client.put(`/appointments/${id}/reschedule`, body);

			const after = await findAppointment(client, id);
			const afterWindow = after ? appointmentWindow(after) : null;
			const matches = afterWindow?.start === start && afterWindow?.end === end;
			return reply(
				[
					`Rescheduled order #${orderNumber(order)} from ${currentWindow ? formatEastern(currentWindow.start) : "(no time)"} to ${formatEastern(start)} until ${formatEastern(end)}.`,
					args.notify_customer ? "The client was notified." : "The client was not notified.",
					matches ? "Checked in Aryeo: the new time is saved." : `Check in Aryeo shows: ${after ? summarizeAppointment(after).when : "appointment not found"}. Please look at it.`,
					clash ? `Note: booked over a clash, as you asked. ${describeClash(clash)}` : "",
				]
					.filter(Boolean)
					.join("\n"),
			);
		}),
	);

	server.registerTool(
		"cancel_appointment",
		{
			title: "Cancel an appointment",
			description:
				"Cancels one appointment, then reads it back from Aryeo to confirm it's canceled. Set notify_customer only if the owner explicitly asks; it can't be sent later.",
			inputSchema: z.object({
				appointment_id: z.string().min(1),
				notify_customer: z.boolean().default(false).describe("Only true if the owner explicitly asked to notify the client."),
			}),
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
		},
		guarded(async ({ appointment_id, notify_customer }) => {
			const client = aryeo();
			const id = safeId(appointment_id, "appointment ID");
			const before = await findAppointment(client, id);
			if (!before) return failure(`Couldn't find appointment ${id} in Aryeo.`);
			const order = await appointmentOrder(client, before);
			if (IGNORED_ORDER_NUMBERS.has(orderNumber(order))) return failure(`Order #${orderNumber(order)} is the old test record; leaving it alone.`);
			await client.put(`/appointments/${id}/cancel`, notify_customer === true ? { notify_customer: true } : {});
			const after = await findAppointment(client, id);
			const status = upper(after?.status) || "(not found)";
			return reply(
				[
					`Cancel sent for order #${orderNumber(order)}, ${summarizeAppointment(before).when}.`,
					notify_customer ? "The client was notified." : "The client was not notified.",
					status.startsWith("CANCEL") ? `Checked in Aryeo: status is now ${status}.` : `Check in Aryeo shows status ${status}. Please look at it.`,
				].join("\n"),
			);
		}),
	);

	server.registerTool(
		"mark_order_paid_offline",
		{
			title: "Record an offline (check) payment",
			description:
				"Records a payment made outside Aryeo, as a check, in US dollars. Refuses amounts above the order total. Date defaults to today (New York).",
			inputSchema: z.object({
				order: z.string().min(1).describe("Order number (e.g. 1042) or order ID."),
				amount_dollars: z.number().positive().max(100_000).describe("e.g. 275 or 275.50"),
				date: z
					.string()
					.regex(/^\d{4}-\d{2}-\d{2}$/)
					.optional()
					.describe("YYYY-MM-DD, defaults to today"),
				record_again: z
					.boolean()
					.default(false)
					.describe("Only true if the owner confirms a second identical payment on the same day is intended."),
			}),
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		},
		guarded(async ({ order, amount_dollars, date, record_again }) => {
			const client = aryeo();
			const id = await resolveOrderId(client, order);
			const { order: full } = await getOrderWithIncludes(client, id, []);
			if (IGNORED_ORDER_NUMBERS.has(orderNumber(full))) return failure(`Order #${orderNumber(full)} is the old test record; leaving it alone.`);
			const cents = Math.round(amount_dollars * 100);
			if (cents <= 0) return failure("The amount has to be more than $0.");
			const total = positiveNumber(full?.total_amount);
			if (total !== null && cents > total) {
				return failure(`$${(cents / 100).toFixed(2)} is more than order #${orderNumber(full)}'s total of ${money(total)}. Nothing was recorded.`);
			}
			const paidOn = date ?? easternDate(now());
			const earlier = await deps.store.recentPayment(id, cents, paidOn);
			if (earlier && !record_again) {
				return failure(
					`A $${(cents / 100).toFixed(2)} payment dated ${paidOn} was already recorded on order #${orderNumber(full)} at ${formatEastern(earlier)}. Nothing was recorded again.`,
				);
			}
			await client.post(`/orders/${id}/payments`, { amount: cents, currency: "USD", collection_source: "CHECK", date: paidOn });
			await deps.store.rememberPayment(id, cents, paidOn, now());
			const { order: after } = await getOrderWithIncludes(client, id, []);
			return reply(
				`Recorded a $${(cents / 100).toFixed(2)} check payment on order #${orderNumber(full)} dated ${paidOn}. Payment status is now ${text(after?.payment_status) || "(not shown)"}.`,
			);
		}),
	);

	return server;
}
