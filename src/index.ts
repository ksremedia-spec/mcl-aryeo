// Entry point. Two jobs in one Worker:
//  - fetch:     the Claude connector at /mcp, behind OAuth sign-in (Google, one account)
//  - scheduled: the auto-confirm check, every 5 minutes, 7 AM-9 PM New York time, only when switched on

import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { ALLOWED_REDIRECT_URIS, type Props, authHandler } from "./auth";
import { createAryeoClient } from "./aryeo";
import { runAutoConfirm } from "./autoconfirm";
import { StateStore } from "./store";
import { buildServer } from "./tools";
import { formatEastern, isWithinCheckHours } from "./time";

const MCP_ROUTE = "/mcp";
const SCOPE = "aryeo";

const apiHandler = {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		// Belt and braces: the sign-in already only lets ALLOWED_EMAIL through.
		const props = (ctx as ExecutionContext & { props?: Props }).props;
		if (!props?.email || props.email.toLowerCase() !== env.ALLOWED_EMAIL.toLowerCase()) {
			return new Response("Forbidden", { status: 403 });
		}
		const store = new StateStore(env.STATE_KV);
		const handler = createMcpHandler(() => buildServer({ env, store, userEmail: props.email }), { route: MCP_ROUTE });
		return handler(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;

// Every token is bound to the connector's exact URL. It's built from the address
// the Worker is reached at (mcl-aryeo.<subdomain>.workers.dev; preview
// URLs are turned off), so no account-specific URL has to be written into the code.
const providers = new Map<string, OAuthProvider<Env>>();

function providerFor(origin: string): OAuthProvider<Env> {
	let provider = providers.get(origin);
	if (!provider) {
		provider = new OAuthProvider<Env>({
			apiRoute: MCP_ROUTE,
			apiHandler,
			defaultHandler: authHandler as ExportedHandler<Env>,
			authorizeEndpoint: "/authorize",
			tokenEndpoint: "/token",
			clientRegistrationEndpoint: "/register",
			clientIdMetadataDocumentEnabled: true,
			// Only Claude may register (sign-in is refused for anything else anyway).
			clientRegistrationCallback: ({ clientMetadata }) => {
				const uris = Array.isArray(clientMetadata.redirect_uris) ? clientMetadata.redirect_uris : [];
				if (!uris.some((uri) => ALLOWED_REDIRECT_URIS.has(String(uri)))) {
					return { description: "Only Claude can connect to this server.", status: 403, code: "access_denied" };
				}
			},
			scopesSupported: [SCOPE, "offline_access"],
			requiredScopes: [SCOPE],
			resourceMetadata: {
				resource: `${origin}${MCP_ROUTE}`,
				resource_name: "Horizon Home Media Aryeo",
			},
		});
		providers.set(origin, provider);
	}
	return provider;
}

export default {
	fetch(request, env, ctx) {
		return providerFor(new URL(request.url).origin).fetch(request, env, ctx);
	},

	async scheduled(controller, env) {
		const now = controller.scheduledTime;
		// Cron runs on UTC; this is where 7 AM-9 PM New York time (and daylight saving) is enforced.
		if (!isWithinCheckHours(now)) return;
		const store = new StateStore(env.STATE_KV);
		if (!(await store.isAutoConfirmOn())) return;

		if (!env.ARYEO_API_KEY) {
			console.error("Auto-confirm check is on but the ARYEO_API_KEY secret is missing.");
			await store.setLastRun({
				at: new Date(now).toISOString(),
				eastern_time: formatEastern(now),
				orders_checked: 0,
				candidates: 0,
				confirmed: 0,
				flagged: 0,
				already_handled: 0,
				errors: ["The ARYEO_API_KEY secret isn't set in Cloudflare."],
				aryeo_calls: 0,
			});
			return;
		}

		const report = await runAutoConfirm({
			aryeo: createAryeoClient(env.ARYEO_API_KEY, { baseUrl: env.ARYEO_BASE_URL }),
			store,
			now,
			dryRun: false,
			source: "auto-check",
		});
		const count = (result: string) => report.outcomes.filter((outcome) => outcome.result === result).length;
		const problems = [
			...report.errors,
			...report.outcomes.flatMap((outcome) => (outcome.result === "try_again_later" ? [`Order #${outcome.order_number}: ${outcome.problem}`] : [])),
		];
		await store.setLastRun({
			at: report.at,
			eastern_time: report.eastern_time,
			orders_checked: report.orders_checked,
			candidates: report.candidates,
			confirmed: count("confirmed"),
			flagged: count("flagged"),
			already_handled: count("already_handled"),
			errors: problems,
			aryeo_calls: report.aryeo_calls,
		});
		console.log("Auto-confirm run", JSON.stringify({ ...report, outcomes: report.outcomes.map((outcome) => outcome.result) }));
	},
} satisfies ExportedHandler<Env>;
