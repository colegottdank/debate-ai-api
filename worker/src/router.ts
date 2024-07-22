import { Router, createCors, error } from 'itty-router';
import { Env, RequestWrapper } from './worker';
import { freeModels, gpt3516k_0125, gpt4o_mini, maxTokensLookup, validModels } from './models';
import { Database } from './database.types';
import { User } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { DebateContext } from './DebateContext';
import StripeServer from './StripeServer';
import Stripe from 'stripe';
import { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

export const { preflight, corsify } = createCors({
	origins: ['*'],
	methods: ['OPTIONS', 'POST', 'GET', 'PUT', 'DELETE'],
	headers: {
		'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, debateai-turn-model',
		'Access-Control-Expose-Headers': 'debateai-turn-model',
	},
});
const roleLookup: Record<string, 'system' | 'user' | 'assistant'> = {
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

	const debateId = crypto.randomUUID();

	console.log(`Debate ID: ${debateId}`);
	const openai = new OpenAI({
		apiKey: request.env.OPENAI_API_KEY,
		baseURL: 'https://oai.hconeai.com/v1',
		defaultHeaders: {
			'Helicone-Auth': 'Bearer ' + request.env.HELICONE_API_KEY,
		},
	});

	const response = await openai.chat.completions
		.create(
			{
				model: gpt4o_mini,
				messages: [
					{ role: 'system', content: 'Generate a short, catchy debate title (2-4 words) for the given topic.' },

					{
						role: 'user',
						content: `Generate a short, catchy debate name for the following topic: "${body.topic}"`,
					},
				],
				tools: [
					{
						type: 'function',
						function: {
							name: 'generate_short_debate_name',
							description: 'Generate a short, catchy debate name based on the given topic.',
							parameters: {
								type: 'object',
								properties: {
									topic: {
										type: 'string',
										description: 'The short debate name. It should be 2-4 words, catchy, and encapsulate the essence of the debate topic.',
									},
								},
								required: ['topic'],
							},
						},
					},
				],
				max_tokens: 100,
				tool_choice: 'auto',
			},
			{
				headers: {
					'Helicone-Property-DebateId': debateId,
					'Helicone-User-Id': request.user?.id ?? body.userId,
					'Helicone-Moderations-Enabled': 'true',
					'Helicone-Session-Name': 'Debate',
					'Helicone-Session-Path': '/debate',
					'Helicone-Session-Id': debateId,
				},
			}
		)
		.withResponse();

	if (response.response.status === 400) throw new Error('Request failed, flagged by moderations.');

	const messages = response.data.choices[0].message?.tool_calls?.[0].function.arguments;

	if (!messages) throw new Error('Messages not found');

	// parse arguments into a result object (generate_debate_name) object
	const result = JSON.parse(messages) as { topic: string };

	const newDebate = await request.supabaseClient
		.from('debates')
		.insert({
			id: debateId,
			topic: body.topic,
			short_topic: cleanContent(result.topic ?? body.topic),
			persona: body.persona,
			model: gpt4o_mini,
			user_id: request.user?.id ?? body.userId,
		})
		.select('*')
		.single();

	if (newDebate.error) throw new Error(`Error occurred inserting new debate: ${JSON.stringify(newDebate.error)}`);
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
	await debateContext.validate();

	// Prepend a system message to turns.data
	const messages: ChatCompletionMessageParam[] = [
		{
			role: 'system',
			content: `Embody ${debateContext.debate.persona} in a debate on '${debateContext.debate.short_topic}'. Adhere to:
	1. Historical Accuracy: Use examples and language from ${debateContext.debate.persona}'s era.
	2. Unique Perspective: Incorporate ${debateContext.debate.persona}'s expertise and views.
	3. Concise Arguments: Present clear, logical points in brief paragraphs.
	4. Direct Engagement: Address opponent's key points without restating them.
	5. Relevant Metaphors: Use analogies from ${debateContext.debate.persona}'s field.
	Avoid modern references. Craft concise, period-authentic arguments in ${debateContext.debate.persona}'s voice.
	Keep all responses under 75 words.`,
		},
	];

	// Case 1: AI Initiates Debate
	if (!debateContext.hasTurns() && debateContext.turnRequest.speaker === 'AI') {
		return await handleAIInitiates(debateContext, messages);
	}

	// Case 2: User Initiates Debate
	if (!debateContext.hasTurns() && debateContext.turnRequest.speaker === 'user') {
		if (!debateContext.turnRequest.argument) throw new Error('Argument not found');
		return await handleUserContinues(debateContext, messages);
	}

	// Case 3: Debate Continues: User Provides Argument
	if (debateContext.hasTurns() && debateContext.turnRequest.speaker === 'user') {
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
	if (debateContext.hasTurns() && debateContext.turnRequest.speaker === 'AI') {
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

async function handleAIInitiates(debateContext: DebateContext, messages: ChatCompletionMessageParam[]) {
	messages.push({
		role: 'user',
		content: `As ${debateContext.debate.persona}, start a brief debate on "${debateContext.debate.short_topic}". Provide a concise opening argument that:
	1. Establishes your historical perspective.
	2. Introduces 1-2 key points relevant to your era.
	3. Uses a brief analogy from your expertise.
	Keep all responses under 75 words.`,
	});

	// messages.push({
	// 	role: 'assistant',
	// 	content: `Ok, I will start the debate about <helicone-prompt-input key="topic">${debateContext.debate.short_topic}</helicone-prompt-input> while remaining in the style of <helicone-prompt-input key="persona">${debateContext.debate.persona}</helicone-prompt-input>!`,
	// });

	const aiResponse = await getAIResponse(messages, debateContext, 'AI', 1, '/debate/turn', 'debate_ai_initiates');

	return new Response(aiResponse, {
		headers: {
			'Content-Type': 'application/octet-stream',
			'DebateAI-Turn-Model': debateContext.model,
		},
	});
}

async function handleUserContinues(debateContext: DebateContext, messages: ChatCompletionMessageParam[]) {
	await insertTurn(debateContext, debateContext.turnRequest.argument, 'user', (debateContext.turns?.length ?? 0) + 1);

	messages.push({
		role: 'user',
		content: `<helicone-prompt-input key="argument">${debateContext.turnRequest.argument}</helicone-prompt-input>`,
	});

	// messages.push({
	// 	role: 'assistant',
	// 	content: `Ok, I will now give a response to the user's argument about <helicone-prompt-input key="topic">${debateContext.debate.short_topic}</helicone-prompt-input> while remaining in the style of <helicone-prompt-input key="persona">${debateContext.debate.persona}</helicone-prompt-input>! I will also keep it short, concise, and to the point! I will also take the opposing side of the debate against the user without repeating myself!`,
	// });

	const aiResponse = await getAIResponse(
		messages,
		debateContext,
		'AI',
		(debateContext.turns?.length ?? 0) + 2,
		'/debate/turn',
		'debate_user_continues'
	);

	return new Response(aiResponse, {
		headers: {
			'Content-Type': 'application/octet-stream',
			'DebateAI-Turn-Model': debateContext.model,
		},
	});
}

async function handleAIForUser(debateContext: DebateContext, messages: ChatCompletionMessageParam[]) {
	const reversedMessages = reverseRoles(messages);

	const systemMessage = reversedMessages.find((message) => message.role === 'system');
	if (systemMessage) {
		systemMessage.content = `As a modern debater, argue against ${debateContext.debate.persona} on '${debateContext.debate.short_topic}'. Your task:
1. Briefly acknowledge the historical context.
2. Present a concise, opposing modern view.
3. Directly counter one key point from their argument.
4. Offer a new insight that challenges their perspective.
Always take the opposite stance. Keep responses under 75 words.`;
	}

	// reversedMessages.push({
	// 	role: 'assistant',
	// 	content: `I will now go directly into my counter argument to the user's argument about <helicone-prompt-input key="topic">${debateContext.debate.short_topic}</helicone-prompt-input>! I will also keep it short, concise, and to the point! I will also take the opposing side of the debate against the user without repeating myself!`,
	// });

	const aiUserResponse = await getAIResponse(
		reversedMessages,
		debateContext,
		'AI_for_user',
		(debateContext.turns?.length ?? 0) + 1,
		'/debate/turn',
		'debate_ai_for_user'
	);

	return new Response(aiUserResponse, {
		headers: {
			'Content-Type': 'application/octet-stream',
			'DebateAI-Turn-Model': debateContext.model,
		},
	});
}

async function handlerAIContinues(debateContext: DebateContext, messages: ChatCompletionMessageParam[]) {
	// messages.push({
	// 	role: 'assistant',
	// 	content: `I will now go directly into my counter argument to the user's argument about <helicone-prompt-input key="topic">${debateContext.debate.short_topic}</helicone-prompt-input> while remaining in the style of <helicone-prompt-input key="persona">${debateContext.debate.persona}</helicone-prompt-input>!! I will also keep it short, concise, and to the point! I will also take the opposing side of the debate against the user without repeating myself!`,
	// });
	const aiResponse = await getAIResponse(
		messages,
		debateContext,
		'AI',
		(debateContext.turns?.length ?? 0) + 1,
		'/debate/turn',
		'debate_ai_continues'
	);

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

function reverseRoles(messages: ChatCompletionMessageParam[]): ChatCompletionMessageParam[] {
	return messages.map((message: any) => {
		return {
			role: message.role === 'system' ? 'system' : message.role === 'user' ? 'assistant' : 'user',
			content: message.content,
		};
	});
}

async function getAIResponse(
	messages: ChatCompletionMessageParam[],
	debateContext: DebateContext,
	speaker: 'user' | 'AI' | 'AI_for_user',
	orderNumber: number,
	path: string,
	promptId: string
): Promise<ReadableStream> {
	console.log(`DebateID: ${debateContext.debate.id}`);

	const openai = new OpenAI({
		apiKey: debateContext.request.env.OPENAI_API_KEY,
		baseURL: 'https://oai.hconeai.com/v1',
		defaultHeaders: {
			'Helicone-Auth': `Bearer ${debateContext.request.env.HELICONE_API_KEY}`,
			'Helicone-Property-DebateId': debateContext.debate.id,
			'Helicone-User-Id': debateContext.userId,
			'Helicone-Moderations-Enabled': 'true',
			'Helicone-Prompt-Id': promptId,
			'Helicone-Session-Name': 'Debate',
			'Helicone-Session-Path': path,
			'Helicone-Session-Id': debateContext.debate.id,
		},
	});

	let gpt_tokenizer = await import('gpt-tokenizer');
	const tokens = gpt_tokenizer.encode(JSON.stringify(messages));
	const maxTokens = maxTokensLookup[debateContext.model] - tokens.length;
	if (maxTokens < 50) throw new Error('Not enough tokens to generate response');
	const result = await openai.chat.completions
		.create({
			model: debateContext.model,
			messages: messages,
			max_tokens: maxTokens,
			stream: true,
		})
		.withResponse();

	if (result.response.status === 400) throw new Error('Request failed, flagged by moderations.');

	let { readable, writable } = new TransformStream();

	let writer = writable.getWriter();
	const textEncoder = new TextEncoder();
	let allContent = ''; // Store all chunks

	(async () => {
		for await (const part of result.data) {
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
		const profile = await request.supabaseClient
			.from('profiles')
			.select('*')
			.eq('id', request.user?.id ?? '')
			.single();

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

			await request.supabaseClient
				.from('profiles')
				.update({ stripe_id: customer.id })
				.eq('id', request.user?.id ?? '');
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
		return gpt3516k_0125;
	}

	if (freeModels.includes(model)) return model;

	// If the user is on their free trial, return the model
	if (user && profile && profile.plan == `free` && profile.pro_trial_count < 5) return model;

	if (!user || !profile?.plan || profile.plan != 'pro') return gpt3516k_0125;

	return model;
}
