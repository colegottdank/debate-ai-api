import { SupabaseClient, User, createClient } from '@supabase/supabase-js';
import { IRequest, json } from 'itty-router';
import { Database } from './database.types';
import apiRouter, { corsify } from './router';
import stripeRouter from './stripeRouter';

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
	'Access-Control-Allow-Origin': '*', // You can restrict it to specific domains
	'Access-Control-Allow-Methods': 'POST, OPTIONS', // Allow only POST and OPTIONS
	'Access-Control-Max-Age': '86400',
	'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
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
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		try {
			let url = new URL(request.url);
			let requestWrapper = request as RequestWrapper;
			requestWrapper.env = env;
			requestWrapper.supabaseClient = createClient<Database>(env.SUPABASE_URL ?? '', env.SUPABASE_KEY ?? '');
			requestWrapper.parsedUrl = url;
			requestWrapper.ctx = ctx;

			let router;
			if (request.url.endsWith('/v1/stripe/webhooks')) router = stripeRouter;
			else router = apiRouter;

			return router
				.handle(requestWrapper)
				.then(json)
				.catch((error: any) => {
					console.error('Error encountered:', error);
					return new Response(error.message, {
						status: error.status || 500,
						headers: corsHeaders,
					});
				})
				.then(corsify);
		} catch (error: any) {
			console.error('Error encountered:', error);
			return new Response(error.message, {
				status: error.status || 500,
				headers: corsHeaders,
			});
		}
	},
};
