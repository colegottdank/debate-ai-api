import { Router, createCors, error } from 'itty-router';
import { Env, RequestWrapper } from './worker';
import { FunctionModel, Model } from './models';
import { CreateChatCompletionRequestMessage } from 'openai/resources/chat';
import { DebateContext, Turn } from './DebateContext';
import StripeServer from './StripeServer';
import Stripe from 'stripe';
import { createDebateTitleFunction as createDebateTitleFuncs, createDebateTitle as createDebateTitleMsgs } from './prompts/CreateDebate';
import { OpenAIWrapper } from './OpenAIWrapper';
import { determineModel } from './Util';
import { turnSystemMessage } from './prompts/Turn';

export const { preflight, corsify } = createCors({
	origins: ['*'],
	methods: ['OPTIONS', 'POST', 'GET', 'PUT', 'DELETE'],
	headers: {
		'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, debateai-turn-model',
		'Access-Control-Expose-Headers': 'debateai-turn-model',
	},
});

const roleLookup: Record<string, 'function' | 'user' | 'system' | 'assistant'> = {
	user: 'user',
	AI: 'assistant',
	AI_for_user: 'user',
};

const apiRouter = Router<RequestWrapper>();
apiRouter.all('*', preflight);

// Create a new debate
apiRouter.post('/v1/debate', authenticate, async (request: RequestWrapper) => {
	const body = await request.json<{
		topic: string;
		persona: string;
		model: Model | FunctionModel;
		userId: string;
	}>();

	if (!body.userId && !request.user) throw new Error('User not found');

	const model = determineModel(body.model, request.user, request.profile);
	const openai = new OpenAIWrapper(request.env.OPENAI_API_KEY, undefined, request.env.HELICONE_API_KEY);

	const titleResult = await openai.call<{ debateTitle: string }>(createDebateTitleMsgs(body.topic), createDebateTitleFuncs(), model, {
		'Helicone-Property-DebateId': crypto.randomUUID(),
		'Helicone-User-Id': body.userId,
	});

	const newDebate = await request.db.createDebate({
		topic: body.topic,
		short_topic: cleanContent(titleResult.debateTitle ?? body.topic),
		persona: body.persona,
		model: model,
		user_id: request.user?.id ?? body.userId,
	});

	return newDebate;

	function cleanContent(content: string): string {
		// Remove quotes at the beginning and end
		content = content.replace(/^["']|["']$/g, '');

		// Remove "Debate Name: " prefix if it exists
		content = content.replace(/^Debate Name: /, '');

		return content.trim();
	}
});

/* ------------------------------- Turn --------------------------------- */

apiRouter.post('/v1/debate/:id/turn', authenticate, async (request) => {
	const debateContext = await DebateContext.create(request, request.params.id);

	const messages: CreateChatCompletionRequestMessage[] = turnSystemMessage(debateContext.debate.short_topic, debateContext.debate.persona);

	// Check if there are existing turns
	const hasTurns = debateContext.turns && debateContext.turns.length > 0;

	// Case 1: AI Initiates Debate
	if (!hasTurns && debateContext.turn.speaker === 'AI') {
		return await handleAIInitiates(debateContext, messages);
	}

	// Case 2: User Initiates Debate
	if (!hasTurns && debateContext.turn.speaker === 'user') {
		if (!debateContext.turn.argument) throw new Error('Argument not found');
		return await handleUserContinues(debateContext, messages);
	}

	// Case 3: Debate Continues: User Provides Argument
	if (hasTurns && debateContext.turn.speaker === 'user') {
		if (!debateContext.turn.argument) throw new Error('Argument not found');
		debateContext.turns?.map((turn) => {
			const role = roleLookup[turn.speaker];

			messages.push({
				role: role,
				content: turn.content,
			});
		});

		if (messages[messages.length - 1].role != 'assistant') throw new Error('Last message is not AI');
		return await handleUserContinues(debateContext, messages);
	}

	// Case 4: AI Responds on User's Behalf
	if (debateContext.turn.speaker === 'AI_for_user') {
		debateContext.turns?.map((turn) => {
			const role = roleLookup[turn.speaker];

			messages.push({
				role: role,
				content: turn.content,
			});
		});

		if (messages[messages.length - 1].role != 'assistant') throw new Error('Last message is not AI');
		return await handleAIForUser(debateContext, messages);
	}

	// Case 5: Debate Continues: AI Provides Argument
	if (hasTurns && debateContext.turn.speaker === 'AI') {
		debateContext.turns?.map((turn) => {
			const role = roleLookup[turn.speaker];

			messages.push({
				role: role,
				content: turn.content,
			});
		});

		if (messages[messages.length - 1].role != 'user') throw new Error('Last message is not user');
		return await handlerAIContinues(debateContext, messages);
	}

	throw new Error('Invalid turn request');
});

async function handleAIInitiates(debateContext: DebateContext, messages: CreateChatCompletionRequestMessage[]) {
	messages.push({
		role: 'user',
		content: `${debateContext.debate.persona}, you start the debate about ${debateContext.debate.short_topic}!`,
	});

	messages.push({
		role: 'assistant',
		content: `Ok, I will start the debate about ${debateContext.debate.short_topic} while remaining in the style of ${debateContext.debate.persona}!`,
	});

	const aiResponse = await callStream(messages, debateContext, 'AI', 1);

	return new Response(aiResponse, {
		headers: {
			'Content-Type': 'application/octet-stream',
			'DebateAI-Turn-Model': debateContext.model,
		},
	});
}

async function handleUserContinues(debateContext: DebateContext, messages: CreateChatCompletionRequestMessage[]) {
	await insertTurn(debateContext, debateContext.turn.argument, 'user', (debateContext.turns?.length ?? 0) + 1);

	messages.push({
		role: 'user',
		content: debateContext.turn.argument,
	});

	messages.push({
		role: 'assistant',
		content: `Ok, I will now give a response to the user's argument about ${debateContext.debate.short_topic} while remaining in the style of ${debateContext.debate.persona}! I will also keep it short, concise, and to the point! I will also take the opposing side of the debate against the user!`,
	});

	const aiResponse = await callStream(messages, debateContext, 'AI', (debateContext.turns?.length ?? 0) + 2);

	return new Response(aiResponse, {
		headers: {
			'Content-Type': 'application/octet-stream',
			'DebateAI-Turn-Model': debateContext.model,
		},
	});
}

async function handleAIForUser(debateContext: DebateContext, messages: CreateChatCompletionRequestMessage[]) {
	const reversedMessages = reverseRoles(messages);

	const systemMessage = reversedMessages.find((message) => message.role === 'system');
	if (systemMessage) {
		systemMessage.content = `You are engaged in a debate about ${debateContext.debate.short_topic}. You are debating against ${debateContext.debate.persona}.
			You are taking the opposing side of the debate against the user.
			Focus on the debate topic and avoid going off-topic.
			Ensure the debate arguments are sounds, quality arguments like a professional debater.
			Always get to the point
			Each argument should be a single paragraph.
			You will not repeat or acknowledge the user's argument, you will instead go directly into your counter argument.`;
	}

	reversedMessages.push({
		role: 'assistant',
		content: `I will now go directly into my counter argument to the user's argument about ${debateContext.debate.short_topic}! I will also keep it short, concise, and to the point! I will also take the opposing side of the debate against the user!`,
	});

	const aiUserResponse = await callStream(reversedMessages, debateContext, 'AI_for_user', (debateContext.turns?.length ?? 0) + 1);

	return new Response(aiUserResponse, {
		headers: {
			'Content-Type': 'application/octet-stream',
			'DebateAI-Turn-Model': debateContext.model,
		},
	});
}

async function handlerAIContinues(debateContext: DebateContext, messages: CreateChatCompletionRequestMessage[]) {
	messages.push({
		role: 'assistant',
		content: `I will now go directly into my counter argument to the user's argument about ${debateContext.debate.short_topic} while remaining in the style of ${debateContext.debate.persona}!! I will also keep it short, concise, and to the point! I will also take the opposing side of the debate against the user!`,
	});
	const aiResponse = await callStream(messages, debateContext, 'AI', (debateContext.turns?.length ?? 0) + 1);

	return new Response(aiResponse, {
		headers: {
			'Content-Type': 'application/octet-stream',
			'DebateAI-Turn-Model': debateContext.model,
		},
	});
}

async function insertTurn(debateContext: DebateContext, content: string, speaker: 'user' | 'AI' | 'AI_for_user', orderNumber: number) {
	return await debateContext.request.supabaseClient.from('turns').insert({
		user_id: debateContext.userId,
		debate_id: debateContext.debate.id,
		speaker: speaker,
		content: content,
		order_number: orderNumber,
		model: debateContext.model,
	});
}

function reverseRoles(messages: CreateChatCompletionRequestMessage[]): CreateChatCompletionRequestMessage[] {
	return messages.map((message) => {
		return {
			role: message.role === 'system' ? 'system' : message.role === 'user' ? 'assistant' : 'user',
			content: message.content,
		};
	});
}

// ###################################################################################
// ################################## Stripe #####################################
// ###################################################################################
apiRouter.post('/v1/stripe/create-checkout-session', authenticateStripe, async (request) => {
	try {
		const stripe = StripeServer.getInstance(request.env);

		// Fetch the list of products
		const products = await stripe.products.list();

		// Find product with name "Pro"
		const proProduct = products.data.find((product) => product.name === 'DebateAI Pro');

		// Make sure the product "Pro" is found
		if (!proProduct) {
			throw new Error("Product 'Pro' not found");
		}

		// Fetch the prices of the "Pro" product
		const prices = await stripe.prices.list({ product: proProduct.id });

		// Make sure there is at least one price for the "Pro" product
		if (prices.data.length === 0) {
			throw new Error("No prices found for the 'Pro' product");
		}

		const customerId = (await getStripeCustomer(request)).id;

		const existingSubscriptions = await stripe.subscriptions.list({
			customer: customerId,
			status: 'active',
		});

		// Check if any of the active subscriptions belong to the "Pro" product
		const hasProSubscription = existingSubscriptions.data.some((subscription) =>
			subscription.items.data.some((item) => item.price.product === proProduct.id)
		);

		if (hasProSubscription) {
			// The customer already has an active subscription to this plan
			return new Response(JSON.stringify({ message: 'You already have an active subscription to this plan' }), {
				status: 400,
			});
		}

		// Use the first price for the checkout session
		const session = await stripe.checkout.sessions.create({
			payment_method_types: ['card'],
			mode: 'subscription',
			line_items: [
				{
					price: prices.data[0].id,
					quantity: 1,
				},
			],
			customer: customerId,
			success_url: `${request.env.FE_URL}?session_id={CHECKOUT_SESSION_ID}`,
			cancel_url: `${request.env.FE_URL}`,
		});

		if (!session.url) throw new Error('Failed to create session');

		let response = {
			url: session.url,
		};

		return new Response(JSON.stringify(response), { status: 200 });
	} catch (error) {
		console.error('Error:', error);
	}
});

apiRouter.post('/v1/stripe/create-portal-session', authenticateStripe, async (request) => {
	try {
		const profile = await request.supabaseClient.from('profiles').select('*').eq('id', request.user?.id).single();

		if (profile.error || !profile.data) {
			throw new Error(profile.error.message);
		}

		const stripe = StripeServer.getInstance(request.env);

		const portalSession = await stripe.billingPortal.sessions.create({
			customer: profile.data.stripe_id ?? (await getStripeCustomer(request)).id,
			return_url: request.env.FE_URL,
		});

		return new Response(JSON.stringify({ url: portalSession.url }), { status: 200 });
	} catch (error: any) {
		console.log('Error creating portal session:', error);
		// You may want to replace this with a more appropriate error response depending on your use case
		return new Response(JSON.stringify({ message: 'Error creating portal session', error: error.toString() }), {
			status: 500,
		});
	}
});

async function getStripeCustomer(request: RequestWrapper): Promise<Stripe.Customer> {
	const stripe = StripeServer.getInstance(request.env);
	try {
		const customers = await stripe.customers.list({
			email: request.user?.email,
			expand: ['data.subscriptions'],
		});
		let customer;
		if (customers.data.length === 0) {
			customer = await stripe.customers.create({
				email: request.user?.email,
				name: request.user?.email,
				expand: ['subscriptions'],
			});

			await request.supabaseClient.from('profiles').update({ stripe_id: customer.id }).eq('id', request.user?.id);
		} else {
			customer = customers.data[0];
		}
		return customer;
	} catch (err) {
		throw new Error('Failed to get customer');
	}
}

// 404 for everything else
apiRouter.all('*', () => error(404));

export default apiRouter;

// ###################################################################################
// ################################## MiddleWare #####################################
// ###################################################################################
async function authenticate(request: RequestWrapper, env: Env): Promise<void> {
	let token = request.headers.get('Authorization')?.replace('Bearer ', '');

	const user = await request.supabaseClient.auth.getUser(token);

	if (user.data && user.data.user) {
		const profile = await request.supabaseClient.from('profiles').select('*').eq('id', user.data.user.id).single();

		if (profile.error) throw new Error(profile.error.message);
		if (!profile.data) throw new Error('Profile not found');

		request.profile = profile.data;
	}

	request.user = user.data.user;
}

async function authenticateStripe(request: RequestWrapper, env: Env): Promise<void> {
	let token = request.headers.get('Authorization')?.replace('Bearer ', '');

	const user = await request.supabaseClient.auth.getUser(token);

	if (!user || !user.data || !user.data.user) throw new Error('User not found');

	const profile = await request.supabaseClient.from('profiles').select('*').eq('id', user.data.user.id).single();

	if (profile.error) throw new Error(profile.error.message);
	if (!profile.data) throw new Error('Profile not found');

	request.profile = profile.data;
	request.user = user.data.user;
}

// Assuming the previous definitions are in scope...
