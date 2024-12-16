import { AutoRouter } from 'itty-router';
import { Env, RequestWrapper } from './worker';
import { gpt4omini, gpt4ominiContextWindow, gpt4ominiMaxCompletionTokens } from './models';
import OpenAI from 'openai';
import { DebateContext } from './DebateContext';
import StripeServer from './StripeServer';
import Stripe from 'stripe';
import { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

const apiRouter = AutoRouter({
	base: '/v1',
	before: [authenticate],
	catch: (error) => {
		console.error('Error:', error);
		return Response.json({ error: error.message || 'An unexpected error occurred' }, { status: error.status || 500 });
	},
});

const roleLookup: Record<string, 'system' | 'user' | 'assistant'> = {
	user: 'user',
	AI: 'assistant',
	AI_for_user: 'user',
};

interface NewDebateRequest {
	topic: string;
	persona: string;
	model: string;
	userId: string;
	heh: boolean;
}

apiRouter.post('/debate', authenticate, async (request) => {
	const body = (await request.json()) as NewDebateRequest;
	if (!body.userId && !request.user) throw new Error('User not found');

	const debateId = crypto.randomUUID();

	const openai = new OpenAI({
		apiKey: request.env.OPENAI_API_KEY,
		baseURL: 'https://oai.helicone.ai/v1',
		defaultHeaders: {
			'Helicone-Auth': 'Bearer ' + request.env.HELICONE_API_KEY,
			'Helicone-Property-DebateId': debateId,
			'Helicone-User-Id': request.user?.id ?? body.userId,
			'Helicone-Moderations-Enabled': 'true',
		},
	});
	try {
		const response = await openai.chat.completions
			.create({
				model: gpt4omini,
				messages: [
					{
						role: 'user',
						content: `Please provide a short debate name for the topic: """${body.topic}"""`,
					},
				],
				tools: [
					{
						type: 'function',
						function: {
							name: 'generate_short_debate_name',
							description: 'Generate a short debate name based on a topic.',
							parameters: {
								type: 'object',
								properties: {
									topic: {
										type: 'string',
										description: 'The debate topic. Try to keep it around 3 words. Remove unnecessary words.',
									},
								},
								required: ['topic'],
							},
						},
					},
				],
				max_tokens: 100,
				tool_choice: 'auto',
			})
			.withResponse();

		if (response.response.status === 400) throw new Error('Request failed, flagged by moderations.');
		if (response.response.status === 429) throw new Error('Rate limit exceeded');
		if (response.response.status === 500) throw new Error('OpenAI server error - please try again');

		const messages = response.data.choices[0].message?.tool_calls?.[0].function.arguments;

		if (!messages) throw new Error('Messages not found');

		// parse arguments into a result object (generate_debate_name) object
		const result = JSON.parse(messages) as { topic: string };

		const newDebate = await request.supabaseClient
			.from('debates')
			.insert({
				topic: body.topic,
				short_topic: cleanContent(result.topic ?? body.topic),
				persona: body.persona,
				model: gpt4omini,
				user_id: request.user?.id ?? body.userId,
			})
			.select('*')
			.single();

		if (newDebate.error) throw new Error(`Error occurred inserting new debate: ${newDebate.error.message}`);
		if (!newDebate.data) throw new Error('Debate not found');

		return newDebate.data;
	} catch (error: any) {
		console.error('OpenAI Error:', {
			status: error?.response?.status,
			message: error?.message,
			responseData: error?.response?.data,
			fullError: error,
		});

		if (error?.message?.includes('exceeded your current quota')) {
			return Response.json({ error: 'Service temporarily unavailable. Please try again later.' }, { status: 429 });
		}

		const status = error?.response?.status || 500;
		const message = error?.message || 'An unexpected error occurred';
		return Response.json({ error: message }, { status });
	}
});

function cleanContent(content: string): string {
	// Remove quotes at the beginning and end
	content = content.replace(/^["']|["']$/g, '');

	// Remove "Debate Name: " prefix if it exists
	content = content.replace(/^Debate Name: /, '');

	return content.trim();
}

/* ------------------------------- Turn --------------------------------- */

apiRouter.post('/debate/:id/turn', authenticate, async (request) => {
	const debateContext = await DebateContext.create(request, request.params.id);
	await debateContext.validate();

	// Prepend a system message to turns.data
	const messages: ChatCompletionMessageParam[] = [
		{
			role: 'system',
			content: `You are participating in a structured debate on the topic '${debateContext.debate.short_topic}', adopting the debating style of '${debateContext.debate.persona}'. Your role is to present the counter-perspective against the user's stance. It's crucial to adhere to the following guidelines to maintain the debate's integrity and effectiveness:
			- Stay On-Topic: Concentrate exclusively on the debate subject. Any deviation from the central topic should be avoided to maintain focus and relevance.
			- Clarity and Conciseness: Your responses should be clear and to the point. Each counter-argument you present must be contained within a single, well-structured paragraph, ensuring that your points are communicated effectively and succinctly.
			- Quality of Argumentation: As a professional debater, your arguments should be logical, well-reasoned, and backed by evidence or strong reasoning. The quality of your argumentation is paramount, reflecting depth of thought and understanding of the topic.
			- Direct Counter-Arguments: Do not repeat or explicitly acknowledge the user's argument. Instead, immediately present your counter-argument. This approach maintains the debate's pace and focuses on providing new insights and perspectives.
			- Avoid Repetition: Ensure that your counter-arguments are fresh and provide new value to the debate. Reiterating the same points or getting stuck on a single aspect detracts from the debate's progression and richness.
			- Researcher: Provide evidence, examples, and references to support your counter-arguments. This strengthens your position and adds credibility to your points.
			Your goal is to enrich the debate by introducing diverse viewpoints and robust counterpoints, fostering a dynamic and insightful exchange.`,
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
			'DebateAI-Turn-Model': debateContext.model,
		},
	});
}

async function handleUserContinues(debateContext: DebateContext, messages: ChatCompletionMessageParam[]) {
	await insertTurn(debateContext, debateContext.turnRequest.argument, 'user', (debateContext.turns?.length ?? 0) + 1);

	messages.push({
		role: 'user',
		content: debateContext.turnRequest.argument,
	});

	messages.push({
		role: 'assistant',
		content: `Ok, I will now give a response to the user's argument about ${debateContext.debate.short_topic} while remaining in the style of ${debateContext.debate.persona}! I will also keep it short, concise, and to the point! I will also take the opposing side of the debate against the user without repeating myself!`,
	});

	const aiResponse = await getAIResponse(messages, debateContext, 'AI', (debateContext.turns?.length ?? 0) + 2);

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
		systemMessage.content = `You are participating in a structured debate on the topic '${debateContext.debate.short_topic}', you're debating against '${debateContext.debate.persona}'. Your role is to present the counter-perspective against the user's stance. It's crucial to adhere to the following guidelines to maintain the debate's integrity and effectiveness:
		- Stay On-Topic: Concentrate exclusively on the debate subject. Any deviation from the central topic should be avoided to maintain focus and relevance.
		- Clarity and Conciseness: Your responses should be clear and to the point. Each counter-argument you present must be contained within a single, well-structured paragraph, ensuring that your points are communicated effectively and succinctly.
		- Quality of Argumentation: As a professional debater, your arguments should be logical, well-reasoned, and backed by evidence or strong reasoning. The quality of your argumentation is paramount, reflecting depth of thought and understanding of the topic.
		- Direct Counter-Arguments: Do not repeat or explicitly acknowledge the user's argument. Instead, immediately present your counter-argument. This approach maintains the debate's pace and focuses on providing new insights and perspectives.
		- Avoid Repetition: Ensure that your counter-arguments are fresh and provide new value to the debate. Reiterating the same points or getting stuck on a single aspect detracts from the debate's progression and richness.
		- Researcher: Provide evidence, examples, and references to support your counter-arguments. This strengthens your position and adds credibility to your points.
		Your goal is to enrich the debate by introducing diverse viewpoints and robust counterpoints, fostering a dynamic and insightful exchange.`;
	}

	reversedMessages.push({
		role: 'assistant',
		content: `I will now go directly into my counter argument to the user's argument about ${debateContext.debate.short_topic}! I will also keep it short, concise, and to the point! I will also take the opposing side of the debate against the user without repeating myself!`,
	});

	const aiUserResponse = await getAIResponse(reversedMessages, debateContext, 'AI_for_user', (debateContext.turns?.length ?? 0) + 1);

	return new Response(aiUserResponse, {
		headers: {
			'Content-Type': 'application/octet-stream',
			'DebateAI-Turn-Model': debateContext.model,
		},
	});
}

async function handlerAIContinues(debateContext: DebateContext, messages: ChatCompletionMessageParam[]) {
	messages.push({
		role: 'assistant',
		content: `I will now go directly into my counter argument to the user's argument about ${debateContext.debate.short_topic} while remaining in the style of ${debateContext.debate.persona}!! I will also keep it short, concise, and to the point! I will also take the opposing side of the debate against the user without repeating myself!`,
	});
	const aiResponse = await getAIResponse(messages, debateContext, 'AI', (debateContext.turns?.length ?? 0) + 1);

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
		model: gpt4omini,
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
	orderNumber: number
): Promise<ReadableStream> {
	const openai = new OpenAI({
		apiKey: debateContext.request.env.OPENAI_API_KEY,
		baseURL: 'https://oai.helicone.ai/v1',
		defaultHeaders: {
			'Helicone-Auth': `Bearer ${debateContext.request.env.HELICONE_API_KEY}`,
			'Helicone-Property-DebateId': debateContext.turnRequest.debateId,
			'Helicone-User-Id': debateContext.userId,
			'Helicone-Moderations-Enabled': 'true',
		},
	});

	let gpt_tokenizer = await import('gpt-tokenizer');
	const inputTokens = gpt_tokenizer.encode(JSON.stringify(messages));

	// Check if input is within context window
	if (inputTokens.length > gpt4ominiContextWindow) {
		throw new Error('Input exceeds maximum context window');
	}

	// Set max completion tokens (being conservative to ensure we stay within limits)
	const maxCompletionTokens = Math.min(gpt4ominiMaxCompletionTokens, gpt4ominiContextWindow - inputTokens.length);

	if (maxCompletionTokens < 50) {
		throw new Error('Not enough tokens remaining for response');
	}

	console.log(`Model: ${gpt4omini}`);
	console.log(`Max Tokens: ${maxCompletionTokens}`);
	const result = await openai.chat.completions
		.create({
			model: gpt4omini,
			messages: messages,
			max_tokens: maxCompletionTokens,
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

apiRouter.post('/stripe/create-checkout-session', authenticateStripe, async (request) => {
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

apiRouter.post('/stripe/create-portal-session', authenticateStripe, async (request) => {
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
apiRouter.all('*', () => new Response('Not Found', { status: 404 }));

export default apiRouter;

// ###################################################################################
// ################################## MiddleWare #####################################
// ###################################################################################
async function authenticate(request: RequestWrapper, env: Env): Promise<void> {
	let token = request.headers.get('Authorization')?.replace('Bearer ', '');

	// If token is undefined or invalid, continue as anonymous
	if (!token || token === 'undefined') {
		return;
	}

	// Only try to authenticate if there's a valid token
	try {
		const user = await request.supabaseClient.auth.getUser(token);
		if (user.data && user.data.user) {
			const profile = await request.supabaseClient.from('profiles').select('*').eq('id', user.data.user.id).single();

			if (profile.data) {
				request.profile = profile.data;
				request.user = user.data.user;
			}
		}
	} catch (error) {
		// If authentication fails, continue as anonymous
		console.log('Authentication failed, continuing as anonymous');
	}
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
