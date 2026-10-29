// Sign-in for the connector. Claude is the OAuth client; this Worker is the
// OAuth server (via @cloudflare/workers-oauth-provider) and hands the actual
// sign-in to Google. Only one Google account (ALLOWED_EMAIL) gets in, and only
// Claude's own callback URL can receive a sign-in.

import {
	AuthorizationError,
	CimdFetchError,
	type ConsentDescription,
	type OAuthHelpers,
	authorizationErrorRedirect,
} from "@cloudflare/workers-oauth-provider";

export interface Props {
	email: string;
	googleSub: string;
}

type AuthEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

/** Claude's hosted apps (web, desktop, mobile) sign in through these. Nothing else may. */
export const ALLOWED_REDIRECT_URIS = new Set(["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback"]);

const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

function page(title: string, body: string, status = 200, headers?: Headers): Response {
	const responseHeaders = headers ?? new Headers();
	responseHeaders.set("Content-Type", "text/html; charset=utf-8");
	responseHeaders.set("Cache-Control", "no-store");
	// form-action also governs where the form's redirect may go: Google to sign in, Claude on Cancel.
	responseHeaders.set(
		"Content-Security-Policy",
		"default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://accounts.google.com https://claude.ai https://claude.com; frame-ancestors 'none'",
	);
	responseHeaders.set("X-Frame-Options", "DENY");
	responseHeaders.set("Referrer-Policy", "no-referrer");
	const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body{font:16px/1.5 system-ui,-apple-system,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#1f2328;background:#fff}
h1{font-size:1.4rem}.box{border:1px solid #d0d7de;border-radius:10px;padding:1rem 1.25rem;margin:1rem 0}
button{font:inherit;padding:.6rem 1.2rem;border-radius:8px;border:1px solid #1f2328;cursor:pointer;margin-right:.5rem}
.primary{background:#1f2328;color:#fff}.muted{color:#59636e;font-size:.9rem}
@media (prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}.box{border-color:#30363d}.muted{color:#9198a1}button{border-color:#e6edf3;background:#0d1117;color:#e6edf3}.primary{background:#e6edf3;color:#0d1117}}
</style></head><body>${body}</body></html>`;
	return new Response(html, { status, headers: responseHeaders });
}

function errorPage(message: string, status = 400): Response {
	return page("Sign-in problem", `<h1>Sign-in problem</h1><p>${escapeHtml(message)}</p><p class="muted">Close this tab and try connecting again from Claude.</p>`, status);
}

function consentPage(details: ConsentDescription, handle: string, allowedEmail: string): string {
	const publisher = details.clientDomain
		? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
		: "This app registered itself, so its name isn't verified.";
	return `<h1>Connect ${escapeHtml(details.clientName)} to Horizon Home Media's Aryeo?</h1>
<div class="box">
<p>${publisher} Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
<p>It will be able to read your Aryeo orders and appointments, and (when you approve each action in Claude) confirm, reschedule, cancel or create bookings and record offline payments.</p>
</div>
<p>Next you'll sign in with Google. Only <strong>${escapeHtml(allowedEmail)}</strong> is allowed.</p>
<form method="post">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
<button class="primary" name="decision" value="approve">Continue with Google</button>
<button name="decision" value="deny">Cancel</button>
</form>`;
}

function base64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function pkceChallenge(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return base64Url(new Uint8Array(digest));
}

function decodeJwtPayload(jwt: string): any {
	const part = jwt.split(".")[1];
	if (!part) throw new Error("Google returned a malformed ID token.");
	const padded = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
	return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))));
}

function renderAuthError(error: unknown): Response {
	if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
	if (error instanceof AuthorizationError) return errorPage(error.description || "This sign-in link has expired or was already used.");
	if (error instanceof CimdFetchError) return errorPage("The app asking to connect couldn't be verified.");
	throw error;
}

async function handleAuthorizeGet(request: Request, env: AuthEnv): Promise<Response> {
	if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
		return errorPage("Google sign-in isn't set up yet: add the GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET secrets in Cloudflare.", 503);
	}
	const oauth = env.OAUTH_PROVIDER;
	const authRequest = await oauth.parseAuthRequest(request);
	if (!ALLOWED_REDIRECT_URIS.has(authRequest.redirectUri)) {
		return errorPage("Only Claude (claude.ai) can connect to this server.", 403);
	}
	const details = await oauth.describeConsent(authRequest);
	const consent = await oauth.beginConsent(authRequest);
	return page("Connect to Horizon Home Media's Aryeo", consentPage(details, consent.handle, env.ALLOWED_EMAIL), 200, consent.headers);
}

async function handleAuthorizePost(request: Request, env: AuthEnv): Promise<Response> {
	const oauth = env.OAUTH_PROVIDER;
	const form = await request.formData();
	const handle = String(form.get("handle") ?? "");
	if (form.get("decision") !== "approve") {
		const denied = await oauth.denyConsent(request, handle);
		denied.headers.set("Location", denied.redirectTo);
		return new Response(null, { status: 302, headers: denied.headers });
	}
	const approved = await oauth.approveConsent(request, handle);
	if (!ALLOWED_REDIRECT_URIS.has(approved.request.redirectUri)) {
		return errorPage("Only Claude (claude.ai) can connect to this server.", 403);
	}
	const verifier = base64Url(crypto.getRandomValues(new Uint8Array(48)));
	const { state, headers } = await oauth.beginUpstream(approved.request, { data: { verifier }, headers: approved.headers });
	const google = new URL(GOOGLE_AUTHORIZE_URL);
	google.searchParams.set("client_id", env.GOOGLE_CLIENT_ID ?? "");
	google.searchParams.set("redirect_uri", new URL("/callback", request.url).href);
	google.searchParams.set("response_type", "code");
	google.searchParams.set("scope", "openid email");
	google.searchParams.set("state", state);
	google.searchParams.set("code_challenge", await pkceChallenge(verifier));
	google.searchParams.set("code_challenge_method", "S256");
	google.searchParams.set("prompt", "select_account");
	google.searchParams.set("login_hint", env.ALLOWED_EMAIL);
	headers.set("Location", google.href);
	return new Response(null, { status: 302, headers });
}

async function handleCallback(request: Request, env: AuthEnv): Promise<Response> {
	const oauth = env.OAUTH_PROVIDER;
	const url = new URL(request.url);
	const { request: original, data, headers } = await oauth.finishUpstream<{ verifier: string }>(request);

	if (url.searchParams.get("error")) {
		headers.set("Location", authorizationErrorRedirect(original, "access_denied"));
		return new Response(null, { status: 302, headers });
	}
	const code = url.searchParams.get("code");
	if (!code) return errorPage("Google didn't send back a sign-in code.");

	const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: new URLSearchParams({
			code,
			client_id: env.GOOGLE_CLIENT_ID ?? "",
			client_secret: env.GOOGLE_CLIENT_SECRET ?? "",
			redirect_uri: new URL("/callback", request.url).href,
			grant_type: "authorization_code",
			code_verifier: data.verifier,
		}),
	});
	const tokens: any = await tokenResponse.json().catch(() => ({}));
	if (!tokenResponse.ok || typeof tokens.id_token !== "string") {
		console.error("Google token exchange failed", tokenResponse.status, tokens?.error);
		return errorPage("Google sign-in didn't complete. Check the Google client ID and secret in Cloudflare.", 502);
	}

	// The ID token came straight from Google's token endpoint over TLS, so its
	// claims can be trusted without re-checking the signature (OpenID Connect Core 3.1.3.7).
	const claims = decodeJwtPayload(tokens.id_token);
	const email = String(claims.email ?? "").toLowerCase();
	const allowed = env.ALLOWED_EMAIL.toLowerCase();
	const valid =
		GOOGLE_ISSUERS.has(claims.iss) &&
		claims.aud === env.GOOGLE_CLIENT_ID &&
		typeof claims.exp === "number" &&
		claims.exp * 1000 > Date.now() &&
		claims.email_verified === true &&
		typeof claims.sub === "string" &&
		claims.sub.length > 0;
	if (!valid || email !== allowed) {
		console.warn("Refused sign-in", { email: email || "(none)", valid });
		return page(
			"Not allowed",
			`<h1>This account can't use the connector</h1><p>You signed in as <strong>${escapeHtml(email || "an unknown account")}</strong>. Only ${escapeHtml(env.ALLOWED_EMAIL)} is allowed.</p><p class="muted">Close this tab and connect again from Claude, choosing the right Google account.</p>`,
			403,
			headers,
		);
	}

	const { redirectTo } = await oauth.completeAuthorization({
		request: original,
		userId: claims.sub,
		metadata: { label: email },
		scope: original.scope,
		props: { email, googleSub: claims.sub } satisfies Props,
	});
	headers.set("Location", redirectTo);
	return new Response(null, { status: 302, headers });
}

function landingPage(request: Request): Response {
	const mcpUrl = new URL("/mcp", request.url).href;
	return page(
		"Horizon Home Media Aryeo connector",
		`<h1>Horizon Home Media Aryeo connector</h1><p>This is a private Claude connector. In Claude, add a custom connector with this URL:</p><div class="box"><code>${escapeHtml(mcpUrl)}</code></div><p class="muted">Sign-in is limited to one Google account.</p>`,
	);
}

export const authHandler: ExportedHandler<AuthEnv> = {
	async fetch(request, env) {
		const { pathname } = new URL(request.url);
		try {
			if (pathname === "/authorize" && request.method === "GET") return await handleAuthorizeGet(request, env);
			if (pathname === "/authorize" && request.method === "POST") return await handleAuthorizePost(request, env);
			if (pathname === "/callback" && request.method === "GET") return await handleCallback(request, env);
			if (pathname === "/" && request.method === "GET") return landingPage(request);
			return new Response("Not found", { status: 404 });
		} catch (error) {
			return renderAuthError(error);
		}
	},
};
