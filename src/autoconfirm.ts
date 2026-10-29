// The auto-confirm rules, shared by the 5-minute check, the "preview" tool and
// the "confirm appointment" tool.
//
// A booking is confirmed only when ALL of these hold:
//   - it is an UNSCHEDULED appointment with a preferred_start_at, not on order #1005
//   - the client picked an exact time (not just a day / part of day)
//   - the preferred time is in the future
//   - we know how long the shoot is
//   - it doesn't overlap any SCHEDULED appointment (checked against every appointment)
// Anything else is flagged for manual review. Temporary problems (Aryeo down,
// rate limits) are not recorded, so the next run tries again.
// Client notifications are never sent from here.

import {
	type AryeoClient,
	AryeoError,
	IGNORED_ORDER_NUMBERS,
	asList,
	getOrderWithIncludes,
	listAllAppointments,
	safeId,
} from "./aryeo";
import {
	appointmentOrderId,
	appointmentWindow,
	clientName,
	formatAddress,
	orderAddressObject,
	orderNumber,
	overlaps,
	positiveNumber,
	text,
	upper,
} from "./format";
import { type AddressCheck, checkAddress } from "./geocode";
import { type ActivityEntry, type PartySummary, type StateStore, handledKey } from "./store";
import { TIME_ZONE, easternDate, formatEastern, toIso } from "./time";

export interface CheckContext {
	aryeo: AryeoClient;
	store: StateStore;
	now: number;
	/** Preview mode: decide everything, change nothing (no Aryeo writes, no KV writes). */
	dryRun: boolean;
	source: ActivityEntry["source"];
	/** Used for the independent geocode. */
	fetchFn?: typeof fetch;
	maxAppointmentPages?: number;
}

export type Outcome =
	| { result: "confirmed"; dryRun: boolean; entry: ActivityEntry }
	| { result: "flagged"; dryRun: boolean; entry: ActivityEntry }
	| { result: "already_handled"; appointment_id: string; order_number: string; previously: string }
	| { result: "try_again_later"; appointment_id: string; order_number: string; problem: string }
	| { result: "not_eligible"; appointment_id: string; order_number: string; reason: string };

interface RunState {
	appointments: any[] | null;
	appointmentsComplete: boolean;
	appointmentsError: string | null;
	orders: Map<string, any>;
}

export function newRunState(): RunState {
	return { appointments: null, appointmentsComplete: false, appointmentsError: null, orders: new Map() };
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function timeRange(start: number | null, end: number | null): string {
	if (start === null) return "(no time)";
	if (end === null) return formatEastern(start);
	if (easternDate(start) !== easternDate(end)) return `${formatEastern(start)} to ${formatEastern(end)}`;
	const endClock = new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, hour: "numeric", minute: "2-digit" }).format(new Date(end));
	return `${formatEastern(start)} to ${endClock}`;
}

async function orderDetails(ctx: CheckContext, state: RunState, order: any): Promise<any> {
	const id = text(order?.id);
	if (!id) return order ?? {};
	const cached = state.orders.get(id);
	if (cached) return cached;
	let merged = order;
	try {
		const needsAddress = !orderAddressObject(order);
		const needsCustomer = clientName(order) === "(no client name)";
		if (needsAddress || needsCustomer || !order?.number) {
			const { order: full } = await getOrderWithIncludes(
				ctx.aryeo,
				id,
				[needsAddress ? "address" : "", needsCustomer ? "customer" : ""].filter(Boolean),
			);
			merged = { ...full, ...order, address: orderAddressObject(order) ?? full.address, customer: order?.customer ?? full.customer };
		}
	} catch {
		// Details are for the log only; carry on with what we have.
	}
	state.orders.set(id, merged);
	return merged;
}

function party(order: any, appointment: any, start: number | null, end: number | null): PartySummary {
	return {
		order_number: orderNumber(order),
		order_id: text(order?.id),
		address: formatAddress(orderAddressObject(order)),
		client: clientName(order),
		appointment_id: text(appointment?.id),
		time: timeRange(start, end),
		start_at: start === null ? null : toIso(start),
		end_at: end === null ? null : toIso(end),
	};
}

async function durationMinutes(
	ctx: CheckContext,
	order: any,
	appointment: any,
): Promise<{ minutes: number; source: string } | null> {
	const direct = positiveNumber(appointment?.duration) ?? positiveNumber(appointment?.duration_minutes);
	if (direct) return { minutes: direct, source: "the appointment's duration" };

	const fromItems = (items: unknown): number | null => {
		if (!Array.isArray(items)) return null;
		let total = 0;
		for (const item of items) {
			total +=
				positiveNumber(item?.duration) ??
				positiveNumber(item?.product_variant?.duration) ??
				positiveNumber(item?.variant?.duration) ??
				positiveNumber(item?.product?.duration) ??
				0;
		}
		return total > 0 ? total : null;
	};

	const attached = fromItems(appointment?.items);
	if (attached) return { minutes: attached, source: "the products on the appointment" };

	const id = text(order?.id);
	if (!id) return null;
	const { order: withItems } = await getOrderWithIncludes(ctx.aryeo, id, ["items"]);
	const ordered = fromItems(withItems?.items);
	return ordered ? { minutes: ordered, source: "the products on the order" } : null;
}

async function loadAllAppointments(ctx: CheckContext, state: RunState): Promise<void> {
	if (state.appointments || state.appointmentsError) return;
	try {
		const all = await listAllAppointments(ctx.aryeo, ctx.maxAppointmentPages ?? 200);
		state.appointments = all.items;
		state.appointmentsComplete = all.complete;
	} catch (error) {
		state.appointmentsError = describeError(error);
	}
}

/**
 * Decide what to do with one appointment and (unless previewing) do it.
 * `respectHandled` is true for the automatic check; the confirm tool re-checks
 * a booking even if it was flagged earlier, but all the safety rules still apply.
 */
export async function evaluateAppointment(
	ctx: CheckContext,
	state: RunState,
	order: any,
	appointment: any,
	{ respectHandled }: { respectHandled: boolean },
): Promise<Outcome> {
	const appointmentId = text(appointment?.id);
	const number = orderNumber(order);
	const base = { appointment_id: appointmentId, order_number: number };

	if (IGNORED_ORDER_NUMBERS.has(number)) {
		return { result: "not_eligible", ...base, reason: `Order #${number} is the old test record and is always ignored.` };
	}
	if (upper(appointment?.status) !== "UNSCHEDULED") {
		return {
			result: "not_eligible",
			...base,
			reason: `This appointment is ${upper(appointment?.status) || "in an unknown state"}, not UNSCHEDULED, so there's nothing to confirm.`,
		};
	}
	const preferredText = text(appointment?.preferred_start_at);
	if (!preferredText) {
		return { result: "not_eligible", ...base, reason: "The client didn't pick a preferred time." };
	}
	try {
		safeId(appointmentId, "appointment ID");
	} catch (error) {
		return { result: "not_eligible", ...base, reason: describeError(error) };
	}

	const preferred = Date.parse(preferredText);
	const key = handledKey(appointmentId, Number.isNaN(preferred) ? preferredText : preferred);
	if (respectHandled) {
		const previous = await ctx.store.getHandled(key);
		if (previous) {
			return { result: "already_handled", ...base, previously: `${previous.kind} on ${formatEastern(previous.at)}: ${previous.reason}` };
		}
	}

	const flag = async (reason: string, details: Partial<ActivityEntry> & { booking: PartySummary }): Promise<Outcome> => {
		const entry: ActivityEntry = { at: new Date(ctx.now).toISOString(), kind: "flagged", source: ctx.source, reason, ...details };
		if (!ctx.dryRun) {
			await ctx.store.markHandled(key, { kind: "flagged", at: entry.at, reason, order_number: number });
			await ctx.store.addActivity(entry);
		}
		return { result: "flagged", dryRun: ctx.dryRun, entry };
	};

	if (Number.isNaN(preferred)) {
		const fullOrder = await orderDetails(ctx, state, order);
		return flag(`Needs manual review: the preferred time "${preferredText}" couldn't be read.`, {
			booking: party(fullOrder, appointment, null, null),
		});
	}

	const preferenceType = upper(appointment?.preference_type);
	if (preferenceType && preferenceType !== "TIME") {
		const fullOrder = await orderDetails(ctx, state, order);
		const window = text(appointment?.preferred_start_at_time_of_day);
		return flag(
			`Needs manual review: the client picked a ${preferenceType.toLowerCase()} preference${window ? ` (${window.toLowerCase()})` : ""}, not an exact time.`,
			{ booking: party(fullOrder, appointment, preferred, null) },
		);
	}

	if (preferred <= ctx.now) {
		const fullOrder = await orderDetails(ctx, state, order);
		return flag("Needs manual review: the preferred time is in the past.", {
			booking: party(fullOrder, appointment, preferred, null),
		});
	}

	let duration: { minutes: number; source: string } | null;
	try {
		duration = await durationMinutes(ctx, order, appointment);
	} catch (error) {
		return { result: "try_again_later", ...base, problem: `Couldn't load the order's products: ${describeError(error)}` };
	}
	if (!duration) {
		const fullOrder = await orderDetails(ctx, state, order);
		return flag("Needs manual review: couldn't find how long this shoot is (no duration on the appointment or its products).", {
			booking: party(fullOrder, appointment, preferred, null),
		});
	}
	const window = { start: preferred, end: preferred + duration.minutes * 60_000 };

	await loadAllAppointments(ctx, state);
	if (state.appointmentsError || !state.appointments) {
		return {
			result: "try_again_later",
			...base,
			problem: `Couldn't load every appointment to check for clashes: ${state.appointmentsError ?? "unknown error"}`,
		};
	}

	const fullOrder = await orderDetails(ctx, state, order);
	const booking = party(fullOrder, appointment, window.start, window.end);

	if (!state.appointmentsComplete) {
		return flag("Needs manual review: there were too many appointments to check them all for clashes.", { booking });
	}

	const clash = state.appointments.find((other) => {
		if (text(other?.id) === appointmentId || upper(other?.status) !== "SCHEDULED") return false;
		const otherWindow = appointmentWindow(other);
		return otherWindow !== null && overlaps(window, otherWindow);
	});
	if (clash) {
		const clashWindow = appointmentWindow(clash);
		const clashOrderId = appointmentOrderId(clash);
		const clashOrder = clashOrderId ? await orderDetails(ctx, state, { ...(clash.order ?? {}), id: clashOrderId }) : (clash.order ?? {});
		return flag("Scheduling conflict, needs manual review.", {
			booking,
			conflict_with: party(clashOrder, clash, clashWindow?.start ?? null, clashWindow?.end ?? null),
		});
	}

	const notes = [`Shoot length ${duration.minutes} minutes, taken from ${duration.source}.`];
	let addressCheck: AddressCheck | null = null;
	try {
		addressCheck = await checkAddress(orderAddressObject(fullOrder), ctx.fetchFn);
	} catch {
		// The address check is advisory here; never block a confirmation on it.
	}
	if (addressCheck && !addressCheck.ok) notes.push(...addressCheck.problems.map((problem) => `Address check: ${problem}`));

	const entry: ActivityEntry = {
		at: new Date(ctx.now).toISOString(),
		kind: "confirmed",
		source: ctx.source,
		reason: `Confirmed for the client's preferred time.`,
		booking,
		notes,
	};

	if (!ctx.dryRun) {
		try {
			await ctx.aryeo.put(`/appointments/${appointmentId}/schedule`, { start_at: toIso(window.start), end_at: toIso(window.end) });
		} catch (error) {
			if (error instanceof AryeoError && error.isDefinitiveRefusal) {
				return flag(`Needs manual review: Aryeo refused to confirm it (${describeError(error)}).`, { booking });
			}
			return { result: "try_again_later", ...base, problem: `Aryeo didn't accept the confirmation right now: ${describeError(error)}` };
		}
		await ctx.store.markHandled(key, { kind: "confirmed", at: entry.at, reason: entry.reason, order_number: number });
		await ctx.store.addActivity(entry);
	}

	// Later bookings in the same run must see this one as taken.
	state.appointments = state.appointments.filter((other) => text(other?.id) !== appointmentId);
	state.appointments.push({
		id: appointmentId,
		status: "SCHEDULED",
		start_at: toIso(window.start),
		end_at: toIso(window.end),
		order: { id: text(fullOrder?.id), number: fullOrder?.number },
	});

	return { result: "confirmed", dryRun: ctx.dryRun, entry };
}

export interface RunReport {
	at: string;
	eastern_time: string;
	dry_run: boolean;
	orders_checked: number;
	candidates: number;
	outcomes: Outcome[];
	errors: string[];
	aryeo_calls: number;
}

/** One pass of the auto-confirm check over the 10 newest orders. */
export async function runAutoConfirm(ctx: CheckContext): Promise<RunReport> {
	const report: RunReport = {
		at: new Date(ctx.now).toISOString(),
		eastern_time: formatEastern(ctx.now),
		dry_run: ctx.dryRun,
		orders_checked: 0,
		candidates: 0,
		outcomes: [],
		errors: [],
		aryeo_calls: 0,
	};

	let orders: any[];
	try {
		orders = asList(await ctx.aryeo.get("/orders", { per_page: 10, sort: "-created_at", include: "appointments" }));
	} catch (error) {
		report.errors.push(`Couldn't load the newest orders: ${describeError(error)}`);
		report.aryeo_calls = ctx.aryeo.calls;
		return report;
	}
	report.orders_checked = orders.length;

	const candidates: { order: any; appointment: any }[] = [];
	for (const order of orders) {
		if (IGNORED_ORDER_NUMBERS.has(orderNumber(order))) continue;
		for (const appointment of Array.isArray(order?.appointments) ? order.appointments : []) {
			if (upper(appointment?.status) === "UNSCHEDULED" && text(appointment?.preferred_start_at)) {
				candidates.push({ order, appointment });
			}
		}
	}
	// First come, first served: if two new requests clash, the older order wins.
	candidates.sort((a, b) => {
		const created = (Date.parse(text(a.order?.created_at)) || 0) - (Date.parse(text(b.order?.created_at)) || 0);
		return created || Date.parse(text(a.appointment.preferred_start_at)) - Date.parse(text(b.appointment.preferred_start_at));
	});
	report.candidates = candidates.length;

	const state = newRunState();
	for (const { order, appointment } of candidates) {
		try {
			report.outcomes.push(await evaluateAppointment(ctx, state, order, appointment, { respectHandled: true }));
		} catch (error) {
			report.errors.push(`Order #${orderNumber(order)}: ${describeError(error)}`);
		}
	}
	report.aryeo_calls = ctx.aryeo.calls;
	return report;
}
