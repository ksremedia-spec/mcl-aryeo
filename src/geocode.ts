// Address sanity check. Aryeo's geocoder sometimes drops the pin in the wrong
// place, so before an address is used we make sure the street number and name
// are filled in and that Aryeo's pin is close to where an independent geocoder
// (the free US Census Bureau geocoder, no account needed) puts the same address.

import { text } from "./format";

const CENSUS_URL = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";
/** How far apart the two pins may be before we call it a mis-pin. */
export const MAX_PIN_DISTANCE_METERS = 300;

export interface AddressCheck {
	/** True only when every check passed, including the independent geocode. */
	ok: boolean;
	problems: string[];
	aryeoPin: { lat: number; lng: number } | null;
	independentPin: { lat: number; lng: number; matched: string } | null;
	distanceMeters: number | null;
}

export function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
	const rad = Math.PI / 180;
	const dLat = (b.lat - a.lat) * rad;
	const dLng = (b.lng - a.lng) * rad;
	const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
	return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

function coordinate(value: unknown): number | null {
	const n = typeof value === "string" ? Number(value) : value;
	return typeof n === "number" && Number.isFinite(n) ? n : null;
}

export async function checkAddress(address: any, doFetch: typeof fetch = fetch): Promise<AddressCheck> {
	const result: AddressCheck = { ok: false, problems: [], aryeoPin: null, independentPin: null, distanceMeters: null };
	if (!address || typeof address !== "object") {
		result.problems.push("There is no address to check.");
		return result;
	}
	const streetNumber = text(address.street_number);
	const streetName = text(address.street_name);
	if (!streetNumber) result.problems.push("The street number is empty.");
	if (!streetName) result.problems.push("The street name is empty.");

	const lat = coordinate(address.latitude);
	const lng = coordinate(address.longitude);
	if (lat === null || lng === null || (lat === 0 && lng === 0)) result.problems.push("Aryeo has no map pin for this address.");
	else result.aryeoPin = { lat, lng };

	const oneLine = [
		[streetNumber, streetName].filter(Boolean).join(" "),
		text(address.city),
		[text(address.state_or_province), text(address.postal_code)].filter(Boolean).join(" "),
	]
		.filter(Boolean)
		.join(", ");

	if (streetNumber && streetName) {
		try {
			const url = new URL(CENSUS_URL);
			url.searchParams.set("address", oneLine);
			url.searchParams.set("benchmark", "Public_AR_Current");
			url.searchParams.set("format", "json");
			const response = await doFetch(url.toString(), {
				headers: { Accept: "application/json" },
				signal: AbortSignal.timeout(10_000),
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const body: any = await response.json();
			const match = body?.result?.addressMatches?.[0];
			const x = coordinate(match?.coordinates?.x);
			const y = coordinate(match?.coordinates?.y);
			if (x === null || y === null) {
				result.problems.push(`The independent geocoder couldn't find "${oneLine}", so the map pin couldn't be double-checked.`);
			} else {
				result.independentPin = { lat: y, lng: x, matched: text(match?.matchedAddress) };
			}
		} catch (error) {
			result.problems.push(`The independent geocoder didn't answer (${(error as Error).message}), so the map pin couldn't be double-checked.`);
		}
	}

	if (result.aryeoPin && result.independentPin) {
		const meters = Math.round(distanceMeters(result.aryeoPin, result.independentPin));
		result.distanceMeters = meters;
		if (meters > MAX_PIN_DISTANCE_METERS) {
			const miles = (meters / 1609.34).toFixed(1);
			result.problems.push(
				`Aryeo's map pin is about ${miles} miles (${meters} m) from where the independent geocoder puts "${result.independentPin.matched || oneLine}". The pin may be wrong.`,
			);
		}
	}

	result.ok = result.problems.length === 0;
	return result;
}
