// The auto-confirm rules, shared by the 5-minute check, the "preview" tool and
// the "confirm appointment" tool.
//
// A booking is confirmed only when ALL of these hold:
//   - it is an UNSCHEDULED appointment with a preferred_start_at, not on order #1005
//   - the client picked an exact time (not just a day / part of day)
//   - the preferred time is in the future
//   - we know how long the shoot is (the products' durations)
//   - it doesn't overlap any scheduled appointment (checked against every appointment)
// Anything else is flagged for manual review. Whenever Aryeo's answer is
// missing, unreadable or in an unexpected shape, nothing is confirmed and
// nothing is recorded, so the next run tries again.
// Client notifications are never sent from here.

import {
	type AryeoClient,
	AryeoError,
	IGNORED_ORDER_NUMBERS,
	asListStrict,
	findAppointment,
	getOrderWithIncludes,
	listAllAppointments,
	safeId,
} from "./aryeo";
import {
	appointmentOrderId,
	clientName,
	formatAddress,
	orderAddressObject,
	orderNumber,
	overlaps,
	parseAryeoTime,
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
	/** Every appointment that blocks its time slot, plus anything confirmed (or possibly confirmed) this run. */
	appointments: any[] | null;
	appointmentsComplete: boolean;
	appointmentsError: string | null;
	orders: Map<string, any>;
}

export function newRunState(): RunState {
	return { appointments: null, appointmentsComplete: false, appointmentsError: null, orders: new Map() };
}

/** Statuses that don't take up a time slot. Everything else does, so an unfamiliar status fails safe. */
const FREE_STATUSES = new Set(["UNSCHEDULED", "CANCELED", "CANCELLED"]);

export function blocksItsSlot(appointment: any): boolean {
	return !FREE_STATUSES.has(upper(appointment?.status));
}

/** The time an appointment occupies, or null when it can't be read with confidence. */
export function occupiedWindow(appointment: any): { start: number; end: number } | null {
	const start = parseAryeoTime(appointment?.start_at);
	if (Number.isNaN(start)) return null;
	const end = parseAryeoTime(appointment?.end_at);
	if (!Number.isNaN(end) && end > start) return { start, end };
	const minutes = positiveNumber(appointment?.duration);
	return minutes ? { start, end: start + minutes * 60_000 } : null;
}

/** The key under which a booking request is remembered once handled. */
export function bookingKey(appointment: any): string {
	const preferredText = text(appointment?.preferred_start_at);
	const preferred = parseAryeoTime(preferredText);
	return handledKey(text(appointment?.id), Number.isNaN(preferred) ? preferredText : preferred);
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
		if (needsAddress || needsCustomer || order?.number === undefined || order?.number === null) {
			const { order: full } = await getOrderWithIncludes(
				ctx.aryeo,
				id,
				[needsAddress ? "address" : "", needsCustomer ? "customer" : ""].filter(Boolean),
			);
			merged = {
				...full,
				...order,
				number: order?.number ?? full.number,
				address: orderAddressObject(order) ?? full.address,
				customer: order?.customer ?? full.customer,
			};
		}
	} catch {
		// Details are mostly for the log; the order-number check below still fails safe.
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

function productMinutes(items: unknown): number | null {
	if (!Array.isArray(items)) return null;
	let total = 0;
	let found = false;
	for (const item of items) {
		const minutes =
			positiveNumber(item?.duration) ??
			positiveNumber(item?.product_variant?.duration) ??
			positiveNumber(item?.variant?.duration) ??
			positiveNumber(item?.product?.duration);
		if (minutes) {
			total += minutes;
			found = true;
		}
	}
	return found ? total : null;
}

type ShootLength = { minutes: number; source: string } | { problem: string } | null;

/**
 * The shoot length is the products' duration, as the owner specified. The
 * appointment's own duration is only a fallback when no product has one, and
 * if the two disagree the booking goes to manual review instead of guessing.
 */
async function shootLength(ctx: CheckContext, order: any, appointment: any): Promise<ShootLength> {
	let products = productMinutes(appointment?.items);
	let source = "the products on the appointment";
	const appointmentsOnOrder = Array.isArray(order?.appointments) ? order.appointments.length : 1;
	if (products === null && appointmentsOnOrder <= 1 && text(order?.id)) {
		const { order: withItems } = await getOrderWithIncludes(ctx.aryeo, text(order.id), ["items"]);
		products = productMinutes(withItems?.items);
		source = "the products on the order";
	}
	const own = positiveNumber(appointment?.duration) ?? positiveNumber(appointment?.duration_minutes);
	if (products !== null && own !== null && products !== own) {
		return { problem: `the products add up to ${products} minutes but the appointment says ${own} minutes` };
	}
	if (products !== null) return { minutes: products, source };
	if (own !== null) return { minutes: own, source: "the appointment's duration (no product had one)" };
	return null;
}

async function loadAllAppointments(ctx: CheckContext, state: RunState): Promise<void> {
	if (state.appointments || state.appointmentsError) return;
	try {
		const all = await listAllAppointments(ctx.aryeo, ctx.maxAppointmentPages ?? 200);
		const unreadable = all.items.filter((a) => blocksItsSlot(a) && occupiedWindow(a) === null);
		if (unreadable.length) {
			const ids = unreadable.slice(0, 5).map((a) => text(a?.id) || "(no id)").join(", ");
			state.appointmentsError = `${unreadable.length} scheduled appointment(s) have no readable start/end time (${ids}), so clashes can't be ruled out.`;
			return;
		}
		state.appointments = all.items.filter(blocksItsSlot);
		state.appointmentsComplete = all.complete;
	} catch (error) {
		state.appointmentsError = describeError(error);
	}
}

/** Mark a time slot as taken for the rest of this run. */
function reserve(state: RunState, appointmentId: string, window: { start: number; end: number }, order: any): void {
	if (!state.appointments) return;
	state.appointments = state.appointments.filter((other) => text(other?.id) !== appointmentId);
	state.appointments.push({
		id: appointmentId,
		status: "SCHEDULED",
		start_at: toIso(window.start),
		end_at: toIso(window.end),
		order: { id: text(order?.id), number: order?.number },
	});
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
	const listedNumber = orderNumber(order);
	const base = { appointment_id: appointmentId, order_number: listedNumber };

	if (IGNORED_ORDER_NUMBERS.has(listedNumber)) {
		return { result: "not_eligible", ...base, reason: `Order #${listedNumber} is the old test record and is always ignored.` };
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

	const key = bookingKey(appointment);
	if (respectHandled) {
		const previous = await ctx.store.getHandled(key);
		if (previous) {
			return { result: "already_handled", ...base, previously: `${previous.kind} on ${formatEastern(previous.at)}: ${previous.reason}` };
		}
	}

	// Load the order's details now, and re-check #1005 with them: the list may
	// not have carried the order number.
	const fullOrder = await orderDetails(ctx, state, order);
	const number = orderNumber(fullOrder);
	if (IGNORED_ORDER_NUMBERS.has(number)) {
		return { result: "not_eligible", ...base, order_number: number, reason: `Order #${number} is the old test record and is always ignored.` };
	}
	if (number === "(no number)") {
		return { result: "try_again_later", ...base, problem: "Couldn't tell which order number this booking belongs to." };
	}
	const known = { appointment_id: appointmentId, order_number: number };

	const flag = async (reason: string, details: Partial<ActivityEntry> & { booking: PartySummary }): Promise<Outcome> => {
		const entry: ActivityEntry = { at: new Date(ctx.now).toISOString(), kind: "flagged", source: ctx.source, reason, ...details };
		if (!ctx.dryRun) {
			// Log first: if anything fails after this, the booking is flagged again next run rather than silently dropped.
			await ctx.store.addActivity(entry);
			await ctx.store.markHandled(key, { kind: "flagged", at: entry.at, reason, order_number: number });
		}
		return { result: "flagged", dryRun: ctx.dryRun, entry };
	};

	const preferred = parseAryeoTime(preferredText);
	if (Number.isNaN(preferred)) {
		return flag(`Needs manual review: the preferred time "${preferredText}" couldn't be read (it needs a date, time and time zone).`, {
			booking: party(fullOrder, appointment, null, null),
		});
	}

	const preferenceType = upper(appointment?.preference_type);
	if (preferenceType && preferenceType !== "TIME") {
		const window = text(appointment?.preferred_start_at_time_of_day);
		return flag(
			`Needs manual review: the client picked a ${preferenceType.toLowerCase()} preference${window ? ` (${window.toLowerCase()})` : ""}, not an exact time.`,
			{ booking: party(fullOrder, appointment, preferred, null) },
		);
	}

	if (preferred <= ctx.now) {
		return flag("Needs manual review: the preferred time is in the past.", { booking: party(fullOrder, appointment, preferred, null) });
	}

	let length: ShootLength;
	try {
		length = await shootLength(ctx, fullOrder, appointment);
	} catch (error) {
		return { result: "try_again_later", ...known, problem: `Couldn't load the order's products: ${describeError(error)}` };
	}
	if (!length) {
		return flag("Needs manual review: couldn't find how long this shoot is (no duration on its products or the appointment).", {
			booking: party(fullOrder, appointment, preferred, null),
		});
	}
	if ("problem" in length) {
		return flag(`Needs manual review: ${length.problem}.`, { booking: party(fullOrder, appointment, preferred, null) });
	}
	const window = { start: preferred, end: preferred + length.minutes * 60_000 };
	const booking = party(fullOrder, appointment, window.start, window.end);

	await loadAllAppointments(ctx, state);
	if (state.appointmentsError || !state.appointments) {
		return {
			result: "try_again_later",
			...known,
			problem: `Couldn't check every appointment for clashes: ${state.appointmentsError ?? "unknown error"}`,
		};
	}
	if (!state.appointmentsComplete) {
		return flag("Needs manual review: there were too many appointments to check them all for clashes.", { booking });
	}

	const clash = state.appointments.find((other) => {
		if (text(other?.id) === appointmentId) return false;
		const otherWindow = occupiedWindow(other);
		return otherWindow !== null && overlaps(window, otherWindow);
	});
	if (clash) {
		const clashWindow = occupiedWindow(clash);
		const clashOrderId = appointmentOrderId(clash);
		const clashOrder = clashOrderId ? await orderDetails(ctx, state, { ...(clash.order ?? {}), id: clashOrderId }) : (clash.order ?? {});
		return flag("Scheduling conflict, needs manual review.", {
			booking,
			conflict_with: party(clashOrder, clash, clashWindow?.start ?? null, clashWindow?.end ?? null),
		});
	}

	const notes = [`Shoot length ${length.minutes} minutes, from ${length.source}.`];
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
		reason: "Confirmed for the client's preferred time.",
		booking,
		notes,
	};

	if (ctx.dryRun) {
		reserve(state, appointmentId, window, fullOrder);
		return { result: "confirmed", dryRun: true, entry };
	}

	try {
		await ctx.aryeo.put(`/appointments/${appointmentId}/schedule`, {
			start_at: toIso(window.start),
			end_at: toIso(window.end),
			notify_customer: false,
		});
	} catch (error) {
		if (error instanceof AryeoError && error.isDefinitiveRefusal) {
			return flag(`Needs manual review: Aryeo refused to confirm it (${describeError(error)}).`, { booking });
		}
		// Aryeo may have saved it even though the answer got lost, so treat the
		// slot as taken for the rest of this run. Next run sees the real status.
		reserve(state, appointmentId, window, fullOrder);
		return { result: "try_again_later", ...known, problem: `Aryeo didn't clearly accept the confirmation: ${describeError(error)}` };
	}
	// Taken from this moment on, whatever happens below.
	reserve(state, appointmentId, window, fullOrder);

	try {
		const saved = await findAppointment(ctx.aryeo, appointmentId);
		const savedWindow = saved ? occupiedWindow(saved) : null;
		if (!saved || !blocksItsSlot(saved) || savedWindow?.start !== window.start || savedWindow?.end !== window.end) {
			notes.push(
				`Read back from Aryeo: ${saved ? `${upper(saved.status) || "unknown status"}, ${timeRange(savedWindow?.start ?? null, savedWindow?.end ?? null)}` : "not found"}. Please check it in Aryeo.`,
			);
		}
	} catch (error) {
		notes.push(`Couldn't read it back from Aryeo to double-check (${describeError(error)}).`);
	}

	await ctx.store.addActivity(entry);
	await ctx.store.markHandled(key, { kind: "confirmed", at: entry.at, reason: entry.reason, order_number: number });
	return { result: "confirmed", dryRun: false, entry };
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

	if (!ctx.dryRun && !(await ctx.store.tryLock(ctx.now, ctx.source))) {
		report.errors.push("Another auto-confirm run (or a confirmation through Claude) was still in progress, so this run was skipped.");
		return report;
	}
	try {
		let orders: any[];
		try {
			orders = asListStrict(await ctx.aryeo.get("/orders", { per_page: 10, sort: "-created_at", include: "appointments" }), "order list");
		} catch (error) {
			report.errors.push(`Couldn't load the newest orders: ${describeError(error)}`);
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
			const created = (parseAryeoTime(a.order?.created_at) || 0) - (parseAryeoTime(b.order?.created_at) || 0);
			return created || parseAryeoTime(a.appointment.preferred_start_at) - parseAryeoTime(b.appointment.preferred_start_at);
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
		return report;
	} finally {
		report.aryeo_calls = ctx.aryeo.calls;
		if (!ctx.dryRun) await ctx.store.unlock();
	}
}
