// Secrets are set in the Cloudflare dashboard, so `wrangler types` can't see them.
// They are optional here because the Worker must still start (and explain what's
// missing) before they have been added.
interface SecretBindings {
	ARYEO_API_KEY?: string;
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
	/** Testing only: point the Aryeo client at a local mock server. Never set in production. */
	ARYEO_BASE_URL?: string;
}

interface Env extends SecretBindings {}
declare namespace Cloudflare {
	interface Env extends SecretBindings {}
}
