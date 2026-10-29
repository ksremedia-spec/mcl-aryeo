// What the auto-confirm check remembers between runs, kept in Cloudflare KV:
// - the on/off switch (missing = OFF)
// - which bookings were already confirmed or flagged, so nothing is handled twice
// - an activity log you can read back through Claude
// - a summary of the last run

const SWITCH_KEY = "settings:auto-confirm";
const SWITCH_HISTORY_KEY = "settings:auto-confirm:changed";
const LAST_RUN_KEY = "status:last-run";
const HANDLED_PREFIX = "handled:";
const ACTIVITY_PREFIX = "activity:";
const LOCK_KEY = "lock:auto-confirm";
const PAYMENT_PREFIX = "payment:";
/** A run normally takes seconds; a lock older than this is treated as abandoned. */
const LOCK_SECONDS = 240;
const MAX_TIMESTAMP = 9_999_999_999_999;

export interface PartySummary {
	order_number: string;
	order_id: string;
	address: string;
	client: string;
	appointment_id: string;
	time: string;
	start_at: string | null;
	end_at: string | null;
}

export type ActivityKind = "confirmed" | "flagged";

export interface ActivityEntry {
	at: string;
	kind: ActivityKind;
	/** "auto-check" for the 5-minute check, "claude" when confirmed through the connector. */
	source: "auto-check" | "claude";
	reason: string;
	booking: PartySummary;
	conflict_with?: PartySummary;
	notes?: string[];
}

export interface HandledRecord {
	kind: ActivityKind;
	at: string;
	reason: string;
	order_number: string;
}

export interface LastRun {
	at: string;
	eastern_time: string;
	orders_checked: number;
	candidates: number;
	confirmed: number;
	flagged: number;
	already_handled: number;
	errors: string[];
	aryeo_calls: number;
}

/** One booking request = one appointment asking for one specific time. */
export function handledKey(appointmentId: string, preferredStart: number | string): string {
	const when = typeof preferredStart === "number" ? new Date(preferredStart).toISOString() : preferredStart;
	return `${HANDLED_PREFIX}${appointmentId}:${when}`;
}

export class StateStore {
	constructor(private readonly kv: KVNamespace) {}

	async isAutoConfirmOn(): Promise<boolean> {
		return (await this.kv.get(SWITCH_KEY)) === "on";
	}

	async switchHistory(): Promise<{ on: boolean; at: string; by: string } | null> {
		return this.kv.get(SWITCH_HISTORY_KEY, "json");
	}

	async setAutoConfirm(on: boolean, by: string, now: number): Promise<void> {
		await this.kv.put(SWITCH_KEY, on ? "on" : "off");
		await this.kv.put(SWITCH_HISTORY_KEY, JSON.stringify({ on, at: new Date(now).toISOString(), by }));
	}

	async getHandled(key: string): Promise<HandledRecord | null> {
		return this.kv.get(key, "json");
	}

	async markHandled(key: string, record: HandledRecord): Promise<void> {
		await this.kv.put(key, JSON.stringify(record));
	}

	async addActivity(entry: ActivityEntry): Promise<void> {
		// Newest-first ordering: KV lists keys alphabetically, so store an inverted timestamp.
		const inverted = String(MAX_TIMESTAMP - Date.parse(entry.at)).padStart(13, "0");
		const key = `${ACTIVITY_PREFIX}${inverted}:${crypto.randomUUID().slice(0, 8)}`;
		await this.kv.put(key, JSON.stringify(entry));
	}

	async listActivity(limit: number): Promise<ActivityEntry[]> {
		const listing = await this.kv.list({ prefix: ACTIVITY_PREFIX, limit });
		const entries = await Promise.all(listing.keys.map((key) => this.kv.get<ActivityEntry>(key.name, "json")));
		return entries.filter((entry): entry is ActivityEntry => entry !== null);
	}

	/**
	 * Best-effort lock so two runs (or a run and a confirmation through Claude)
	 * don't confirm overlapping bookings at the same moment. KV isn't atomic, so
	 * this narrows the window rather than closing it completely.
	 */
	async tryLock(now: number, holder: string): Promise<boolean> {
		const existing = await this.kv.get<{ at: number; holder: string }>(LOCK_KEY, "json");
		if (existing && now - existing.at < LOCK_SECONDS * 1000) return false;
		await this.kv.put(LOCK_KEY, JSON.stringify({ at: now, holder }), { expirationTtl: LOCK_SECONDS + 60 });
		return true;
	}

	async unlock(): Promise<void> {
		await this.kv.delete(LOCK_KEY);
	}

	/** Remembers an offline payment for a day, so an accidental repeat is caught. */
	async recentPayment(orderId: string, cents: number, date: string): Promise<string | null> {
		return this.kv.get(`${PAYMENT_PREFIX}${orderId}:${cents}:${date}`);
	}

	async rememberPayment(orderId: string, cents: number, date: string, now: number): Promise<void> {
		await this.kv.put(`${PAYMENT_PREFIX}${orderId}:${cents}:${date}`, new Date(now).toISOString(), { expirationTtl: 86_400 });
	}

	async setLastRun(run: LastRun): Promise<void> {
		await this.kv.put(LAST_RUN_KEY, JSON.stringify(run));
	}

	async getLastRun(): Promise<LastRun | null> {
		return this.kv.get(LAST_RUN_KEY, "json");
	}
}
