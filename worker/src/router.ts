import { Router, createCors, error } from 'itty-router';
import { Env, RequestWrapper } from './worker';
import { freeModels, gpt35, gpt4, maxTokensLookup, validModels } from './models';
import { Database } from './database.types';
import { User } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { CreateChatCompletionRequestMessage } from 'openai/resources/chat';

export const { preflight, corsify } = createCors({
	origins: ['*'],
	methods: ['OPTIONS'],
	headers: ['authorization, x-client-info, apikey, content-type'],
});

const router = Router<RequestWrapper>();
router.all('*', preflight);

interface NewDebateRequest {
	topic: string;
	persona: string;
	model: string;
	userId: string;
	heh: boolean;
}

router.post('/v1/debate', authenticate, async (request) => {
	const body = await request.json<NewDebateRequest>();
	if (!body.userId && !request.user) throw new Error('User not found');

	if (!body.heh) validateModel(body.model, request.user, request.profile);

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
			content: `Ok, I will not give you a short name for the debate: ${body.topic}.`,
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
			short_topic: result.choices[0].message?.content ?? body.topic,
			persona: body.persona,
			model: body.model,
			user_id: request.user?.id ?? body.userId,
		})
		.select('*')
		.single();

	if (newDebate.error) throw new Error(newDebate.error.message);
	if (!newDebate.data) throw new Error('Debate not found');

	return newDebate.data;
});

/* ------------------------------- Turn --------------------------------- */

// AI Turn
// Human Turn
// AI as Human Turn
interface TurnRequest {
	userId: string;
	debateId: string;
	argument: string;
	speaker: 'user' | 'AI' | 'AI_for_user';
	heh: boolean;
	model: string;
}

router.post('/v1/turn', authenticate, async (request) => {
	const body = await request.json<TurnRequest>();
	if (!body.userId && !request.user) throw new Error('User not found');

	const debate = await request.supabaseClient.from('debates').select('*').eq('id', body.debateId).single();

	if (debate.error) throw new Error(debate.error.message);
	if (!debate.data) throw new Error('Debate not found');

	if (!body.heh) validateModel(debate.data.model, request.user, request.profile);

	const turns = await request.supabaseClient
		.from('turns')
		.select('*')
		.eq('debate_id', body.debateId)
		.order('order_number', { ascending: true });

	if (turns.error) throw new Error(turns.error.message);

	// Prepend a system message to turns.data
	const messages: CreateChatCompletionRequestMessage[] = [
		{
			role: 'system',
			content: `You are engaged in a debate about ${debate.data.short_topic}. You are debating as ${debate.data.persona}.
			You are taking the opposing side of the debate against the user. Each argument should be a single paragraph.`,
		},
	];

	// No turns yet
	if (!turns.data) {
		// AI starting
		if (body.speaker === 'AI') {
			messages.push({
				role: 'user',
				content: `${debate.data.persona}, you start the debate about ${debate.data.short_topic}!`,
			});
		}
		// User starting
		else if (body.speaker === 'user') {
			messages.push({
				role: 'user',
				content: body.argument,
			});
		}
	} else {
		// There are turns
		turns.data?.map((turn) => {
			const role =
				body.speaker === 'AI_for_user' ? (turn.speaker === 'user' ? 'assistant' : 'user') : turn.speaker === 'user' ? 'user' : 'assistant';

			messages.push({
				role: role,
				content: turn.content,
			});
		});
	}

	const openai = new OpenAI({
		apiKey: request.env.OPENAI_API_KEY,
		baseURL: 'https://oai.hconeai.com/v1',
		defaultHeaders: {
			'Helicone-Auth': `Bearer ${request.env.HELICONE_API_KEY}`,
			'Helicone-Property-DebateId': body.debateId,
			'Helicone-User-Id': request.user?.id ?? body.userId,
		},
	});

	let gpt_tokenizer = await import('gpt-tokenizer');
	const tokens = gpt_tokenizer.encode(JSON.stringify(messages));
	const maxTokens = maxTokensLookup[debate.data.model] - tokens.length;
	const result = await openai.chat.completions.create({
		model: body.model ?? debate.data.model,
		messages: messages,
		max_tokens: maxTokens,
		stream: true,
	});

	// Using our readable and writable to handle streaming data
	let { readable, writable } = new TransformStream();

	let writer = writable.getWriter();
	const textEncoder = new TextEncoder();

	// loop over the data as it is streamed from OpenAI and write it using our writeable
	for await (const part of result) {
		writer.write(textEncoder.encode(part.choices[0]?.delta?.content || ''));
	}

	writer.close();

	// Send readable back to the browser so it can read the stream content
	return new Response(readable, {
		headers: {
			'Content-Type': 'application/octet-stream',
		},
	});

	// // Splitting stream into two
	// const logStream = new PassThrough();
	// const responseStream = new PassThrough();
	// result.data.pipe(logStream);
	// result.data.pipe(responseStream);

	// if (!('on' in result.data)) throw new Error('No data received from OpenAI');
	// if (!(result.data instanceof Readable)) throw new Error('response data does not have Readable.on stream method');

	// let combinedTextData = '';
	// logStream.on('data', (chunk) => {
	// 	const lines: string[] = chunk
	// 		.toString()
	// 		.split('\n')
	// 		.filter((line: string) => line.trim() !== '');
	// 	for (const line of lines) {
	// 		const message = line.replace(/^data: /, '');
	// 		if (message === '[DONE]') {
	// 			return;
	// 		}

	// 		try {
	// 			const parsedMessage = JSON.parse(message);
	// 			combinedTextData += parsedMessage.text;
	// 		} catch (error) {
	// 			throw new Error('Error parsing message as JSON: ' + error);
	// 		}
	// 	}
	// });

	// logStream.on('end', async () => {
	// 	const insertData = async () => {
	// 		try {
	// 			const newTurn = await request.supabaseClient
	// 				.from('turns')
	// 				.insert([
	// 					{
	// 						debate_id: body.debateId,
	// 						content: combinedTextData.trim(),
	// 						speaker: body.isReversed ? 'AI_for_user' : 'AI',
	// 						user_id: request.user?.id ?? body.userId,
	// 						order_number: turns.data.length + 1,
	// 					},
	// 				])
	// 				.select('*');

	// 			if (newTurn.error) throw new Error(newTurn.error.message);
	// 			if (!newTurn.data) throw new Error('Turn not found');
	// 		} catch (error) {
	// 			console.error("Error inserting into 'turns':", error);
	// 		}
	// 	};

	// 	request.ctx.waitUntil(insertData());
	// });

	// return new Response(responseStream, {
	// 	headers: {
	// 		'Content-Type': 'application/octet-stream',
	// 		...corsHeaders, // Spread the CORS headers here
	// 	},
	// });
});

// 404 for everything else
router.all('*', () => error(404));

export default router;

// ###################################################################################
// ################################## MiddleWare #####################################
// ###################################################################################
async function authenticate(request: RequestWrapper, env: Env): Promise<void> {
	let token = request.headers.get('Authorization')?.replace('Bearer ', '');
	// if (!token) throw new Error("Missing 'Authorization' header");

	const user = await request.supabaseClient.auth.getUser(token);

	if (user.data && user.data.user) {
		const profile = await request.supabaseClient.from('profiles').select('*').eq('id', user.data.user.id).single();

		if (profile.error) throw new Error(profile.error.message);
		if (!profile.data) throw new Error('Profile not found');

		request.profile = profile.data;
	}
	// if (user.error) throw new Error(user.error.message);
	// if (!user.data) throw new Error('User not found');

	request.user = user.data.user;

	// Validate if the user is logged in
	// if (!request.user) throw new Error('User not found');
}

function validateModel(model: string, user: User | null, profile: Database['public']['Tables']['profiles']['Row']) {
	if (!validModels.includes(model)) throw new Error('Not a valid model');

	if (!freeModels.includes(model)) {
		if (!user) throw new Error('Not a valid model for anonymous users');
		if (profile.plan == 'free') throw new Error('Not a valid model for free users');
	}
}
