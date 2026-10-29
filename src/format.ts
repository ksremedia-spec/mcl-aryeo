// Pulls the human-readable bits (order number, address, client, times) out of
// Aryeo objects. Field names follow Aryeo's API; a few fallbacks cover shapes
// that vary between endpoints.

import { formatEastern } from "./time";

export function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

export function upper(value: unknown): string {
	return text(value).toUpperCase();
}

export function orderNumber(order: any): string {
	return text(order?.number) || text(order?.order_number) || "(no number)";
}

export function orderAddressObject(order: any): any {
	return order?.address ?? order?.listing?.address ?? null;
}

export function formatAddress(address: any): string {
	if (!address || typeof address !== "object") return "(no address)";
	const unparsed = text(address.unparsed_address);
	if (unparsed) return unparsed;
	const street = [text(address.street_number), text(address.street_name)].filter(Boolean).join(" ");
	const line1 = [street, text(address.unit_number)].filter(Boolean).join(" ");
	const region = [text(address.state_or_province), text(address.postal_code)].filter(Boolean).join(" ");
	const full = [line1, text(address.city), region].filter(Boolean).join(", ");
	return full || "(no address)";
}

function personName(person: any): string {
	if (!person || typeof person !== "object") return "";
	return (
		text(person.name) ||
		[text(person.first_name), text(person.last_name)].filter(Boolean).join(" ") ||
		text(person.title) ||
		text(person.email)
	);
}

export function clientName(order: any): string {
	return (
		personName(order?.customer) ||
		text(order?.customer_name) ||
		personName(order?.customer_user) ||
		personName(order?.agent) ||
		"(no client name)"
	);
}

/**
 * An Aryeo timestamp in ms, or NaN. Only full ISO times with "Z" or an offset
 * count: a time with no zone ("2026-11-04 10:00:00") is ambiguous, and reading
 * it as UTC would put the shoot hours off.
 */
export function parseAryeoTime(value: unknown): number {
	const raw = text(value);
	if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(raw)) return Number.NaN;
	return Date.parse(raw.replace(" ", "T"));
}

export function appointmentOrderId(appointment: any): string {
	return text(appointment?.order?.id) || text(appointment?.order_id);
}

/** Start/end of an appointment in ms, or null when it has no usable times. */
export function appointmentWindow(appointment: any, fallbackMinutes = 60): { start: number; end: number } | null {
	const start = parseAryeoTime(appointment?.start_at);
	if (Number.isNaN(start)) return null;
	let end = parseAryeoTime(appointment?.end_at);
	if (Number.isNaN(end) || end <= start) {
		const minutes = positiveNumber(appointment?.duration) ?? fallbackMinutes;
		end = start + minutes * 60_000;
	}
	return { start, end };
}

export function positiveNumber(value: unknown): number | null {
	const n = typeof value === "string" ? Number(value) : value;
	return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
}

export function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
	return a.start < b.end && b.start < a.end;
}

export interface AppointmentSummary {
	id: string;
	status: string;
	when: string;
	start_at: string | null;
	end_at: string | null;
	preferred_start_at: string | null;
	preferred_time: string | null;
	duration_minutes: number | null;
	title: string | null;
	order_number: string | null;
	photographers: string[];
}

export function summarizeAppointment(appointment: any): AppointmentSummary {
	const start = text(appointment?.start_at) || null;
	const preferred = text(appointment?.preferred_start_at) || null;
	const users = Array.isArray(appointment?.users) ? appointment.users : [];
	return {
		id: text(appointment?.id),
		status: upper(appointment?.status) || "(unknown)",
		when: start ? formatEastern(start) : preferred ? `not scheduled (client asked for ${formatEastern(preferred)})` : "not scheduled",
		start_at: start,
		end_at: text(appointment?.end_at) || null,
		preferred_start_at: preferred,
		preferred_time: preferred ? formatEastern(preferred) : null,
		duration_minutes: positiveNumber(appointment?.duration),
		title: text(appointment?.title) || null,
		order_number: appointment?.order ? orderNumber(appointment.order) : null,
		photographers: users.map(personName).filter(Boolean),
	};
}

export interface OrderSummary {
	number: string;
	id: string;
	created: string;
	client: string;
	address: string;
	fulfillment_status: string | null;
	payment_status: string | null;
	total: string | null;
	ignored_test_record?: true;
	appointments: AppointmentSummary[];
}

export function money(cents: unknown, currency = "USD"): string | null {
	const n = typeof cents === "string" ? Number(cents) : cents;
	if (typeof n !== "number" || !Number.isFinite(n)) return null;
	return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(n / 100);
}

export function summarizeOrder(order: any, ignored = false): OrderSummary {
	const appointments = Array.isArray(order?.appointments) ? order.appointments : [];
	const summary: OrderSummary = {
		number: orderNumber(order),
		id: text(order?.id),
		created: order?.created_at ? formatEastern(order.created_at) : "(unknown)",
		client: clientName(order),
		address: formatAddress(orderAddressObject(order)),
		fulfillment_status: text(order?.fulfillment_status) || null,
		payment_status: text(order?.payment_status) || null,
		total: money(order?.total_amount, text(order?.currency) || "USD"),
		appointments: appointments.map(summarizeAppointment),
	};
	if (ignored) summary.ignored_test_record = true;
	return summary;
}
