import { describe, expect, it } from "vitest";
import { formatEastern, isWithinCheckHours, parseTimeInput } from "../src/time";

// The hours in wrangler.jsonc's cron: */5 0-2,11-23 * * *
const CRON_UTC_HOURS = new Set([0, 1, 2, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);

/** Every 5-minute cron firing on one UTC calendar day that the code would act on, as NY clock times. */
function activeRunsForNyDay(nyDate: string): string[] {
	// Look at firings from 06:00 UTC on that date to 06:00 UTC the next day, which spans the whole NY day.
	const start = Date.parse(`${nyDate}T06:00:00Z`);
	const runs: string[] = [];
	for (let t = start; t < start + 24 * 3600_000; t += 5 * 60_000) {
		if (!CRON_UTC_HOURS.has(new Date(t).getUTCHours())) continue;
		if (isWithinCheckHours(t)) {
			runs.push(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", hourCycle: "h23" }).format(t));
		}
	}
	return runs;
}

describe("check hours (7:00 AM to 9:00 PM New York, through daylight saving)", () => {
	for (const day of ["2026-07-15", "2026-10-31", "2026-11-01", "2026-11-02", "2027-01-15", "2027-03-14", "2027-03-15"]) {
		it(`acts from 07:00 through 21:00 on ${day}`, () => {
			const runs = activeRunsForNyDay(day);
			expect(runs[0]).toBe("07:00");
			expect(runs.at(-1)).toBe("21:00");
			expect(runs.length).toBe(14 * 12 + 1);
		});
	}

	it("uses the right UTC hour on each side of the Nov 1, 2026 fall-back", () => {
		expect(isWithinCheckHours(Date.parse("2026-10-31T11:00:00Z"))).toBe(true); // 7:00 AM EDT
		expect(isWithinCheckHours(Date.parse("2026-11-02T11:00:00Z"))).toBe(false); // 6:00 AM EST
		expect(isWithinCheckHours(Date.parse("2026-11-02T12:00:00Z"))).toBe(true); // 7:00 AM EST
		expect(isWithinCheckHours(Date.parse("2026-11-03T02:00:00Z"))).toBe(true); // 9:00 PM EST
		expect(isWithinCheckHours(Date.parse("2026-11-03T02:05:00Z"))).toBe(false); // 9:05 PM EST
	});
});

describe("parseTimeInput", () => {
	it("reads plain times as New York time, summer and winter", () => {
		expect(new Date(parseTimeInput("2026-07-15T10:00")).toISOString()).toBe("2026-07-15T14:00:00.000Z");
		expect(new Date(parseTimeInput("2026-11-03 10:00")).toISOString()).toBe("2026-11-03T15:00:00.000Z");
	});
	it("keeps explicit zones", () => {
		expect(new Date(parseTimeInput("2026-11-03T10:00:00-05:00")).toISOString()).toBe("2026-11-03T15:00:00.000Z");
		expect(new Date(parseTimeInput("2026-11-03T15:00:00Z")).toISOString()).toBe("2026-11-03T15:00:00.000Z");
	});
	it("rejects dates without a time and nonsense", () => {
		expect(parseTimeInput("2026-11-03")).toBeNaN();
		expect(parseTimeInput("next tuesday")).toBeNaN();
	});
	it("formats in Eastern time", () => {
		expect(formatEastern("2026-11-03T15:00:00Z")).toBe("Tue, Nov 3, 2026, 10:00 AM EST");
	});
});
