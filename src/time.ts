// Eastern-time helpers. Cloudflare runs on UTC, so every "what time is it in
// New York" question goes through Intl, which knows about daylight saving.

export const TIME_ZONE = "America/New_York";

/** First and last minute of the day (Eastern) when the auto-confirm check may act. */
export const CHECK_START_MINUTE = 7 * 60; // 7:00 AM
export const CHECK_END_MINUTE = 21 * 60; // 9:00 PM (the 9:00 run is included)

const partsFormat = new Intl.DateTimeFormat("en-US", {
	timeZone: TIME_ZONE,
	hourCycle: "h23",
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
});

const displayFormat = new Intl.DateTimeFormat("en-US", {
	timeZone: TIME_ZONE,
	weekday: "short",
	month: "short",
	day: "numeric",
	year: "numeric",
	hour: "numeric",
	minute: "2-digit",
	timeZoneName: "short",
});

export interface EasternParts {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
}

export function easternParts(ms: number): EasternParts {
	const out: Record<string, number> = {};
	for (const part of partsFormat.formatToParts(new Date(ms))) {
		if (part.type !== "literal") out[part.type] = Number(part.value);
	}
	return {
		year: out.year,
		month: out.month,
		day: out.day,
		hour: out.hour === 24 ? 0 : out.hour,
		minute: out.minute,
		second: out.second,
	};
}

/** True when `ms` falls between 7:00 AM and 9:00 PM New York time, inclusive. */
export function isWithinCheckHours(ms: number): boolean {
	const { hour, minute } = easternParts(ms);
	const minuteOfDay = hour * 60 + minute;
	return minuteOfDay >= CHECK_START_MINUTE && minuteOfDay <= CHECK_END_MINUTE;
}

/** "Tue, Nov 3, 2026, 10:00 AM EST" */
export function formatEastern(value: number | string | null | undefined): string {
	if (value === null || value === undefined || value === "") return "(no time)";
	const ms = typeof value === "number" ? value : Date.parse(value);
	if (Number.isNaN(ms)) return String(value);
	return displayFormat.format(new Date(ms));
}

/** Today's date in New York as YYYY-MM-DD. */
export function easternDate(ms: number): string {
	const { year, month, day } = easternParts(ms);
	return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** ISO 8601 in UTC without milliseconds: 2026-11-03T15:00:00Z */
export function toIso(ms: number): string {
	return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function easternOffsetMinutes(utcMs: number): number {
	const p = easternParts(utcMs);
	const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
	return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60000);
}

/**
 * Reads a time a person or Claude typed. A time with "Z" or an offset is used as is;
 * a plain "2026-11-03T10:00" (or with a space instead of T) is taken as New York time.
 * Returns NaN when it can't be read.
 */
export function parseTimeInput(text: string): number {
	const trimmed = text.trim();
	const naive = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
	if (!naive) {
		// Only accept full ISO timestamps with a zone, never a bare date.
		if (!/T\d{2}:\d{2}/.test(trimmed) || !/(Z|[+-]\d{2}:?\d{2})$/i.test(trimmed)) return Number.NaN;
		return Date.parse(trimmed);
	}
	const [, y, mo, d, h, mi, s] = naive;
	const guess = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0));
	const firstOffset = easternOffsetMinutes(guess);
	let utc = guess - firstOffset * 60000;
	const secondOffset = easternOffsetMinutes(utc);
	if (secondOffset !== firstOffset) utc = guess - secondOffset * 60000;
	return utc;
}
