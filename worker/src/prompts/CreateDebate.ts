import { CompletionCreateParams, CreateChatCompletionRequestMessage } from 'openai/resources/chat';

export function createDebateTitle(debateTopic: string): CreateChatCompletionRequestMessage[] {
	return [
		{
			role: 'system',
			content: `Your task is to create a title for a debate. The title should be a short phrase that describes the debate. The title should be no more than 50 characters long.`,
		},
		{
			role: 'user',
			content: `Debate topic is: ${debateTopic}`,
		},
	];
}

export function createDebateTitleFunction(): CompletionCreateParams.Function[] {
	return [
		{
			name: 'create_debate_title',
			description: 'Creates a title for a debate.',
			parameters: {
				type: 'object',
				properties: {
					debateTitle: {
						type: 'string',
						description: 'The title of the debate, max 50 characters.',
					},
				},
				required: ['debateTitle'],
			},
		},
	];
}
