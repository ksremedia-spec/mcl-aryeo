// End-to-end sign-in, the way Claude does it: discovery, registration, consent,
// Google, token exchange, then a real MCP tool call. Google and Aryeo are faked.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MemoryKV } from "./helpers";

const ORIGIN = "https://mcl-aryeo.example.workers.dev";
const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";

beforeAll(() => {
	// What workerd exposes when the compatibility flag in wrangler.jsonc is on.
	(globalThis as any).Cloudflare = { compatibilityFlags: { global_fetch_strictly_public: true } };
});
afterEach(() => vi.unstubAllGlobals());

const b64url = (data: string | Uint8Array) => {
	const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
	return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

function fakeIdToken(claims: Record<string, unknown>) {
	return `${b64url(JSON.stringify({ alg: "RS256" }))}.${b64url(JSON.stringify(claims))}.sig`;
}

class Browser {
	cookies = new Map<string, string>();
	store(response: Response) {
		for (const line of response.headers.getSetCookie()) {
			const [pair] = line.split(";");
			const [name, ...rest] = pair.split("=");
			if (/Max-Age=0|expires=Thu, 01 Jan 1970/i.test(line)) this.cookies.delete(name.trim());
			else this.cookies.set(name.trim(), rest.join("="));
		}
	}
	header() {
		return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
	}
}

async function setup(email: string) {
	const worker = (await import("../src/index")).default;
	const env = {
		OAUTH_KV: new MemoryKV().asKV(),
		STATE_KV: new MemoryKV().asKV(),
		ALLOWED_EMAIL: "ksremedia@gmail.com",
		GOOGLE_CLIENT_ID: "google-client-id",
		GOOGLE_CLIENT_SECRET: "google-client-secret",
		ARYEO_API_KEY: "aryeo-key",
		ARYEO_BASE_URL: "http://127.0.0.1:9/v1",
	} as unknown as Env;
	const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
	// Cloudflare always sends a Host header; Node's Request doesn't add one by itself.
	const call = (path: string, init?: RequestInit) => {
		const request = new Request(ORIGIN + path, init);
		request.headers.set("Host", new URL(ORIGIN).host);
		return worker.fetch!(request as any, env, ctx);
	};

	const realFetch = globalThis.fetch;
	const seen: { url: string; body?: string; headers: Headers }[] = [];
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input);
		const body = typeof init?.body === "string" ? init.body : init?.body ? String(init.body) : undefined;
		seen.push({ url, body, headers: new Headers(init?.headers) });
		if (url === "https://oauth2.googleapis.com/token") {
			return Response.json({
				access_token: "google-access",
				id_token: fakeIdToken({
					iss: "https://accounts.google.com",
					aud: "google-client-id",
					sub: "1234567890",
					email,
					email_verified: true,
					exp: Math.floor(Date.now() / 1000) + 3600,
				}),
			});
		}
		if (url.startsWith("http://127.0.0.1:9/v1/orders")) {
			return Response.json({ data: [{ id: "o-1", number: 1042, created_at: "2026-10-28T12:00:00Z", appointments: [], address: { unparsed_address: "12 Harbor Lane, Mystic, CT" }, customer: { name: "Pat Client" } }] });
		}
		return realFetch(input as any, init);
	});
	return { call, seen, env };
}

async function signIn(email: string) {
	const { call, seen } = await setup(email);
	const browser = new Browser();

	const registration = await call("/register", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			client_name: "Claude",
			redirect_uris: [CLAUDE_CALLBACK],
			token_endpoint_auth_method: "none",
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
		}),
	});
	expect(registration.status).toBe(201);
	const { client_id } = (await registration.json()) as { client_id: string };

	const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
	const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
	const query = new URLSearchParams({
		response_type: "code",
		client_id,
		redirect_uri: CLAUDE_CALLBACK,
		scope: "aryeo offline_access",
		state: "claude-state",
		code_challenge: challenge,
		code_challenge_method: "S256",
		resource: `${ORIGIN}/mcp`,
	});
	const consent = await call(`/authorize?${query}`);
	expect(consent.status).toBe(200);
	browser.store(consent);
	const html = await consent.text();
	expect(html).toContain("Only <strong>ksremedia@gmail.com</strong> is allowed");
	const handle = /name="handle" value="([^"]+)"/.exec(html)![1];

	const approve = await call("/authorize", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: browser.header() },
		body: new URLSearchParams({ handle, decision: "approve" }),
	});
	expect(approve.status).toBe(302);
	browser.store(approve);
	const google = new URL(approve.headers.get("Location")!);
	expect(google.origin + google.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
	expect(google.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/callback`);
	expect(google.searchParams.get("scope")).toBe("openid email");
	expect(google.searchParams.get("code_challenge_method")).toBe("S256");

	const callback = await call(`/callback?code=google-code&state=${encodeURIComponent(google.searchParams.get("state")!)}`, {
		headers: { Cookie: browser.header() },
	});
	const googleExchange = seen.find((s) => s.url === "https://oauth2.googleapis.com/token");
	return { call, seen, browser, callback, client_id, verifier, googleExchange };
}

describe("sign-in", () => {
	it("advertises what Claude needs (401 pointer, metadata, CIMD + DCR)", async () => {
		const { call } = await setup("ksremedia@gmail.com");
		const unauthenticated = await call("/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
		expect(unauthenticated.status).toBe(401);
		expect(unauthenticated.headers.get("WWW-Authenticate")).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);

		const resource = (await (await call("/.well-known/oauth-protected-resource/mcp")).json()) as any;
		expect(resource.resource).toBe(`${ORIGIN}/mcp`);
		expect(resource.authorization_servers).toEqual([ORIGIN]);

		const server = (await (await call("/.well-known/oauth-authorization-server")).json()) as any;
		expect(server.client_id_metadata_document_supported).toBe(true);
		expect(server.token_endpoint_auth_methods_supported).toContain("none");
		expect(server.code_challenge_methods_supported).toEqual(["S256"]);
		expect(server.registration_endpoint).toBe(`${ORIGIN}/register`);
		expect(server.scopes_supported).toContain("offline_access");
	});

	it("lets the allowed Google account through and Claude can then use the tools", async () => {
		const { call, callback, client_id, verifier, googleExchange, seen } = await signIn("KSREmedia@gmail.com");
		expect(googleExchange?.body).toContain("code_verifier=");

		expect(callback.status).toBe(302);
		const back = new URL(callback.headers.get("Location")!);
		expect(back.origin + back.pathname).toBe(CLAUDE_CALLBACK);
		expect(back.searchParams.get("state")).toBe("claude-state");

		const token = await call("/token", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "authorization_code",
				code: back.searchParams.get("code")!,
				redirect_uri: CLAUDE_CALLBACK,
				client_id,
				code_verifier: verifier,
				resource: `${ORIGIN}/mcp`,
			}),
		});
		expect(token.status).toBe(200);
		const tokens = (await token.json()) as any;
		expect(tokens.access_token).toBeTruthy();
		expect(tokens.refresh_token).toBeTruthy();

		const mcp = (body: unknown) =>
			call("/mcp", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${tokens.access_token}`,
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
					"MCP-Protocol-Version": "2025-06-18",
				},
				body: JSON.stringify(body),
			});
		const init = await mcp({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-test", version: "1" } },
		});
		expect(init.status).toBe(200);

		const listed = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_orders", arguments: { count: 5 } } });
		const listedText = await listed.text();
		expect(listed.status).toBe(200);
		expect(listedText).toContain("Pat Client");
		const aryeoCall = seen.find((s) => s.url.startsWith("http://127.0.0.1:9/v1/orders"));
		expect(aryeoCall?.headers.get("Accept")).toBe("application/json");
		expect(aryeoCall?.headers.get("Authorization")).toBe("Bearer aryeo-key");

		const bogus = await call("/mcp", {
			method: "POST",
			headers: { Authorization: "Bearer not-a-real-token", "Content-Type": "application/json" },
			body: "{}",
		});
		expect(bogus.status).toBe(401);
	});

	it("refuses any other Google account", async () => {
		const { callback } = await signIn("someone.else@gmail.com");
		expect(callback.status).toBe(403);
		expect(callback.headers.get("Location")).toBeNull();
		expect(await callback.text()).toContain("someone.else@gmail.com");
	});

	it("refuses apps other than Claude", async () => {
		const { call } = await setup("ksremedia@gmail.com");
		const registration = await call("/register", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ client_name: "Claude (honest)", redirect_uris: ["https://evil.example/callback"], token_endpoint_auth_method: "none" }),
		});
		expect(registration.status).toBe(403);

		const mixed = await call("/register", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ client_name: "Sneaky", redirect_uris: [CLAUDE_CALLBACK, "https://evil.example/callback"], token_endpoint_auth_method: "none" }),
		});
		expect(mixed.status).toBe(403);
	});
});
