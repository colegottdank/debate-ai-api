import { Router, createCors, error } from 'itty-router';
import { Env, RequestWrapper } from './worker';
import { freeModels, gpt35, gpt3516k, gpt4, maxTokensLookup, validModels } from './models';
import { Database } from './database.types';
import { User } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { CreateChatCompletionRequestMessage } from 'openai/resources/chat';
import { DebateContext } from './DebateContext';
import StripeServer from './StripeServer';
import Stripe from 'stripe';

export const { preflight, corsify } = createCors({
	origins: ['*'],
	methods: ['OPTIONS'],
	headers: ['authorization, x-client-info, apikey, content-type'],
});

const roleLookup: Record<string, 'function' | 'user' | 'system' | 'assistant'> = {
	user: 'user',
	AI: 'assistant',
	AI_for_user: 'user',
};

const apiRouter = Router<RequestWrapper>();
apiRouter.all('*', preflight);

interface NewDebateRequest {
	topic: string;
	persona: string;
	model: string;
	userId: string;
	heh: boolean;
}

apiRouter.post('/v1/debate', authenticate, async (request) => {
	const body = await request.json<NewDebateRequest>();
	if (!body.userId && !request.user) throw new Error('User not found');

	const model = body.heh ? body.model : validateModel(body.model, request.user, request.profile);

	const messages: CreateChatCompletionRequestMessage[] = [
		{
			role: 'system',
			content:
				"Create a debate name based on the topic. For example, if someone says 'Dogs are better than cats' then the debate name could be 'dogs vs cats'. Always keep it short and simple.",
		},
		{
			role: 'user',
			content: `Debate topic: ${body.topic}`,
		},
		{
			role: 'assistant',
			content: `Ok, I will not give you a short name for the debate without any other characters or quotes: ${body.topic}.`,
		},
	];

	const debateId = crypto.randomUUID();

	const openai = new OpenAI({
		apiKey: request.env.OPENAI_API_KEY,
		baseURL: 'https://oai.hconeai.com/v1',
		defaultHeaders: {
			'Helicone-Auth': 'Bearer ' + request.env.HELICONE_API_KEY,
			'Helicone-Property-DebateId': debateId,
			'Helicone-User-Id': request.user?.id ?? body.userId,
		},
	});

	let gpt_tokenizer = await import('gpt-tokenizer');
	const tokens = gpt_tokenizer.encode(JSON.stringify(messages));
	const maxTokens = maxTokensLookup[gpt35] - tokens.length;
	const result = await openai.chat.completions.create({
		model: gpt4,
		messages: messages,
		max_tokens: maxTokens,
	});

	const newDebate = await request.supabaseClient
		.from('debates')
		.insert({
			topic: body.topic,
			short_topic: cleanContent(result.choices[0].message?.content ?? body.topic),
			persona: body.persona,
			model: model,
			user_id: request.user?.id ?? body.userId,
		})
		.select('*')
		.single();

	if (newDebate.error) throw new Error(`Error occurred inserting new debate: ${newDebate.error.message}`);
	if (!newDebate.data) throw new Error('Debate not found');

	return newDebate.data;
});

function cleanContent(content: string): string {
	// Remove quotes at the beginning and end
	content = content.replace(/^["']|["']$/g, '');

	// Remove "Debate Name: " prefix if it exists
	content = content.replace(/^Debate Name: /, '');

	return content.trim();
}

/* ------------------------------- Turn --------------------------------- */

apiRouter.post('/v1/debate/:id/turn', authenticate, async (request) => {
	const debateContext = await DebateContext.create(request, request.params.id);
	const model = await debateContext.validate();

	// Prepend a system message to turns.data
	const messages: CreateChatCompletionRequestMessage[] = [
		{
			role: 'system',
			content: `You are engaged in a debate about ${debateContext.debate.short_topic}. You are debating in the style of ${debateContext.debate.persona}.
			You are taking the opposing side of the debate against the user.
			Focus on the debate topic and avoid going off-topic.
			Ensure the debate arguments are sounds, quality arguments like a professional debater.
			Always get to the point
			Each argument should be a single paragraph.`,
		},
	];

	// Check if there are existing turns
	const hasTurns = debateContext.turns && debateContext.turns.length > 0;

	// Case 1: AI Initiates Debate
	if (!hasTurns && debateContext.turnRequest.speaker === 'AI') {
		return await handleAIInitiates(debateContext, messages);
	}

	// Case 2: User Initiates Debate
	if (!hasTurns && debateContext.turnRequest.speaker === 'user') {
		if (!debateContext.turnRequest.argument) throw new Error('Argument not found');
		return await handleUserContinues(debateContext, messages);
	}

	// Case 3: Debate Continues: User Provides Argument
	if (hasTurns && debateContext.turnRequest.speaker === 'user') {
		if (!debateContext.turnRequest.argument) throw new Error('Argument not found');
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
	if (debateContext.turnRequest.speaker === 'AI_for_user') {
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
	if (hasTurns && debateContext.turnRequest.speaker === 'AI') {
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

	const aiResponse = await getAIResponse(messages, debateContext, 'AI', 1);

	return new Response(aiResponse, {
		headers: {
			'Content-Type': 'application/octet-stream',
		},
	});
}

async function handleUserContinues(debateContext: DebateContext, messages: CreateChatCompletionRequestMessage[]) {
	await insertTurn(debateContext, debateContext.turnRequest.argument, 'user', (debateContext.turns?.length ?? 0) + 1);

	messages.push({
		role: 'user',
		content: debateContext.turnRequest.argument,
	});

	messages.push({
		role: 'assistant',
		content: `Ok, I will now give a response to the user's argument about ${debateContext.debate.short_topic} while remaining in the style of ${debateContext.debate.persona}! I will also keep it short, concise, and to the point! I will also take the opposing side of the debate against the user!`,
	});

	const aiResponse = await getAIResponse(messages, debateContext, 'AI', (debateContext.turns?.length ?? 0) + 2);

	return new Response(aiResponse, {
		headers: {
			'Content-Type': 'application/octet-stream',
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
			Each argument should be a single paragraph.`;
	}

	reversedMessages.push({
		role: 'assistant',
		content: `Ok, I will now give a response to the user's argument about ${debateContext.debate.short_topic}! I will also keep it short, concise, and to the point! I will also take the opposing side of the debate against the user!`,
	});

	const aiUserResponse = await getAIResponse(reversedMessages, debateContext, 'AI_for_user', (debateContext.turns?.length ?? 0) + 1);

	return new Response(aiUserResponse, {
		headers: {
			'Content-Type': 'application/octet-stream',
		},
	});
}

async function handlerAIContinues(debateContext: DebateContext, messages: CreateChatCompletionRequestMessage[]) {
	messages.push({
		role: 'assistant',
		content: `Ok, I will now give a response to the user's argument about ${debateContext.debate.short_topic} while remaining in the style of ${debateContext.debate.persona}!! I will also keep it short, concise, and to the point! I will also take the opposing side of the debate against the user!`,
	});
	const aiResponse = await getAIResponse(messages, debateContext, 'AI', (debateContext.turns?.length ?? 0) + 1);

	return new Response(aiResponse, {
		headers: {
			'Content-Type': 'application/octet-stream',
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

async function getAIResponse(
	messages: CreateChatCompletionRequestMessage[],
	debateContext: DebateContext,
	speaker: 'user' | 'AI' | 'AI_for_user',
	orderNumber: number
): Promise<ReadableStream> {
	const openai = new OpenAI({
		apiKey: debateContext.request.env.OPENAI_API_KEY,
		baseURL: 'https://oai.hconeai.com/v1',
		defaultHeaders: {
			'Helicone-Auth': `Bearer ${debateContext.request.env.HELICONE_API_KEY}`,
			'Helicone-Property-DebateId': debateContext.turnRequest.debateId,
			'Helicone-User-Id': debateContext.userId,
		},
	});

	let gpt_tokenizer = await import('gpt-tokenizer');
	const tokens = gpt_tokenizer.encode(JSON.stringify(messages));
	const maxTokens = maxTokensLookup[debateContext.model] - tokens.length;
	if (maxTokens < 50) throw new Error('Not enough tokens to generate response');
	const result = await openai.chat.completions.create({
		model: debateContext.model,
		messages: messages,
		max_tokens: maxTokens,
		stream: true,
	});

	let { readable, writable } = new TransformStream();

	let writer = writable.getWriter();
	const textEncoder = new TextEncoder();
	let allContent = ''; // Store all chunks

	(async () => {
		for await (const part of result) {
			const partContent = part.choices[0]?.delta?.content || '';
			allContent += partContent; // Add to the stored content
			await writer.write(textEncoder.encode(partContent));
		}

		debateContext.request.ctx.waitUntil(
			(async () => {
				await insertTurn(debateContext, allContent, speaker, orderNumber);
				await writer.close();
			})()
		);
	})();

	return readable;
}

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

function validateModel(model: string, user: User | null, profile: Database['public']['Tables']['profiles']['Row']): string {
	if (!validModels.includes(model)) {
		console.error('Not a valid model, defaulted to gpt-3.5-turbo 16k');
		return gpt3516k;
	}

	if (freeModels.includes(model)) return model;

	if (!user || !profile?.plan || profile.plan != 'pro') return gpt3516k;

	return model;
}
