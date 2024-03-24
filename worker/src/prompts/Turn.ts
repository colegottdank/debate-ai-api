import { CreateChatCompletionRequestMessage } from 'openai/resources/chat';

export function turnSystemMessage(shortTopic: string, persona: string): CreateChatCompletionRequestMessage[] {
	return [
		{
			role: 'system',
			content: `You're debating ${shortTopic} in the style of ${persona}.
            - You have knowledge of debates and debate tactics, behave like a professional debater and try to win the debate.
            - Focus on the debate topic and avoid going off-topic.
            - Always get to the point
            - Each argument should be a single paragraph.
            - You will not repeat or acknowledge the user's argument, you will instead go directly into your counter argument.`,
		},
	];
}
