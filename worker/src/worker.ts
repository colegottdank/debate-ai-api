import { AutoRouter, cors, IRequest } from 'itty-router';
import { Database } from './database.types';
import apiRouter from './router';
import stripeRouter from './stripeRouter';
import { createClient, SupabaseClient, User } from '@supabase/supabase-js';

const { preflight, corsify } = cors({
	origin: ['https://debateai.org', 'http://localhost:3000', 'https://www.debateai.org'],
	allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
	allowHeaders: ['Content-Type', 'Authorization', 'debateai-turn-model'],
	exposeHeaders: ['debateai-turn-model'],
	maxAge: 86400,
	credentials: true,
});

export interface Env {
	HELICONE_API_KEY: string;
	OPENAI_API_KEY: string;
	SUPABASE_KEY: string;
	SUPABASE_URL: string;
	STRIPE_API_KEY: string;
	STRIPE_WEBHOOK_SECRET: string;
	FE_URL: string;
}

const corsHeaders = {
	'Access-Control-Allow-Origin': 'https://debateai.org',
	'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
	'Access-Control-Max-Age': '86400',
	'Access-Control-Allow-Headers': 'Authorization, Content-Type',
	'Access-Control-Expose-Headers': 'debateai-turn-model',
	'Access-Control-Allow-Credentials': 'true',
};

export type RequestWrapper = {
	env: Env;
	ctx: ExecutionContext;
	supabaseClient: SupabaseClient<Database>;
	user: User | null;
	profile: Database['public']['Tables']['profiles']['Row'];
	parsedUrl: URL;
} & IRequest;

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		if (request.method === 'OPTIONS') {
			return preflight(request);
		}

		try {
			let url = new URL(request.url);
			let requestWrapper = request as RequestWrapper;
			requestWrapper.env = env;
			requestWrapper.supabaseClient = createClient<Database>(env.SUPABASE_URL ?? '', env.SUPABASE_KEY ?? '');
			requestWrapper.parsedUrl = url;
			requestWrapper.ctx = ctx;

			const response = await (request.url.endsWith('/v1/stripe/webhooks')
				? stripeRouter.fetch(requestWrapper)
				: apiRouter.fetch(requestWrapper));

			return corsify(response, request);
		} catch (error: any) {
			return corsify(
				new Response(JSON.stringify({ error: error.message }), {
					status: error.status || 500,
					headers: { 'Content-Type': 'application/json' },
				}),
				request
			);
		}
	},
};
