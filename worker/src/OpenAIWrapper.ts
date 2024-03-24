import OpenAI from 'openai';
import {
	ChatCompletion,
	ChatCompletionChunk,
	ChatCompletionCreateParams,
	ChatCompletionMessageParam,
	ChatCompletionTool,
} from 'openai/resources/chat';
import { FunctionModel, maxTokensLookup } from './models';
import { DebateContext } from './DebateContext';
import { Stream } from 'openai/streaming';

export class OpenAIWrapper {
	private openai: OpenAI;

	constructor(apiKey?: string, org?: string, heliconeApiKey?: string) {
		this.openai = new OpenAI({
			apiKey: process.env.OPENAI_API_KEY ?? apiKey,
			baseURL: 'https://oai.hconeai.com/v1',
			organization: org,
			defaultHeaders: {
				'Helicone-Auth': `Bearer ${process.env.HELICONE_API_KEY ?? heliconeApiKey}`,
			},
		});
	}

	public async call<TResponseBody>(
		messages: ChatCompletionMessageParam[],
		toolCalls: ChatCompletionTool[],
		model: FunctionModel,
		headers?: Record<string, string>
	): Promise<TResponseBody> {
		const maxTokens = await this.calcualteMaxTokens(JSON.stringify(messages));

		let completion: ChatCompletion;
		try {
			completion = await this.openai.chat.completions.create(
				{
					messages: messages,
					model: model,
					tools: toolCalls,
					max_tokens: maxTokens,
				},
				{
					headers: headers,
				}
			);
		} catch (error: any) {
			console.error('Error calling OpenAI ', error);
			throw error;
		}

		const toolArgs = completion.choices[0].message.tool_calls?.[0]?.function.arguments;
		if (!toolArgs) {
			throw new Error('No mapper code generated.');
		}

		let mapperResponse: TResponseBody;
		try {
			mapperResponse = JSON.parse(toolArgs.replace(/[\x00-\x1F\x7F]/g, '')) as TResponseBody;
		} catch (error: any) {
			console.error('Error parsing mapper response: ', error);
			throw error;
		}

		return mapperResponse;
	}

	async callStream2(
		messages: ChatCompletionMessageParam[],
		debateContext: DebateContext,
		speaker: 'user' | 'AI' | 'AI_for_user',
		orderNumber: number,
		headers: Record<string, string>
	): Promise<Stream<ChatCompletionChunk> {

	}
	

	async callStream(
		messages: ChatCompletionMessageParam[],
		debateContext: DebateContext,
		speaker: 'user' | 'AI' | 'AI_for_user',
		orderNumber: number,
		headers: Record<string, string>
	): Promise<Stream<ChatCompletionChunk>> {
		const openai = new OpenAI({
			apiKey: debateContext.request.env.OPENAI_API_KEY,
			baseURL: 'https://oai.hconeai.com/v1',
			defaultHeaders: {
				'Helicone-Auth': `Bearer ${debateContext.request.env.HELICONE_API_KEY}`,
				'Helicone-Property-DebateId': debateContext.debate.id,
				'Helicone-User-Id': debateContext.userId,
			},
		});

		let gpt_tokenizer = await import('gpt-tokenizer');
		const tokens = gpt_tokenizer.encode(JSON.stringify(messages));
		const maxTokens = maxTokensLookup[debateContext.model] - tokens.length;
		if (maxTokens < 50) throw new Error('Not enough tokens to generate response');
		return await openai.chat.completions.create(
			{
				model: debateContext.model,
				messages: messages,
				max_tokens: maxTokens,
				stream: true,
			},
			{
				headers: headers,
			}
		);

		// const [consumerStream, loggingStream] = result.tee();

		// let allContent = ''; // Store all chunks

		// (async () => {
		// 	for await (const part of loggingStream) {
		// 		const partContent = part.choices[0]?.delta?.content || '';
		// 		allContent += partContent; // Add to the stored content
		// 	}

		// 	debateContext.request.ctx.waitUntil(
		// 		(async () => {
		// 			await insertTurn(debateContext, allContent, speaker, orderNumber);
		// 		})()
		// 	);
		// })();

		// return consumerStream;
	}

	private async calcualteMaxTokens(messages: string): Promise<number> {
		let gpt_tokenizer = await import('gpt-tokenizer');
		const tokens = gpt_tokenizer.encode(messages);

		const maxTokens = maxTokensLookup['gpt3516k_0613'] - tokens.length;

		if (maxTokens < 50) throw new Error('Not enough tokens to generate response');

		return maxTokens;
	}
}
