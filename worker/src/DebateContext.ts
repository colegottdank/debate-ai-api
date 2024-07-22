import { Database } from './database.types';
import { RequestWrapper } from './worker';

export interface TurnRequest {
	userId: string;
	debateId: string;
	argument: string;
	speaker: 'user' | 'AI' | 'AI_for_user';
	heh: boolean;
	model: string;
}

export class DebateContext {
	request: RequestWrapper;
	turnRequest: TurnRequest;
	debate: Database['public']['Tables']['debates']['Row'];
	turns: Database['public']['Tables']['turns']['Row'][] | undefined;
	userId: string;
	model: string = 'gpt-4o-mini';

	private constructor(
		request: RequestWrapper,
		turnRequest: TurnRequest,
		debate: Database['public']['Tables']['debates']['Row'],
		turns: Database['public']['Tables']['turns']['Row'][] | undefined
	) {
		this.request = request;
		this.turnRequest = turnRequest;
		this.debate = debate;
		this.turns = turns;
		this.userId = request.user?.id ?? turnRequest.userId;
	}

	static async create(request: RequestWrapper, debateId: string): Promise<DebateContext> {
		const turnRequest = await request.json<TurnRequest>();
		if (!turnRequest) throw new Error('Turn request not found');

		const debate = await request.supabaseClient.from('debates').select('*').eq('id', debateId).single();

		if (debate.error) throw new Error(debate.error.message);
		if (!debate.data) throw new Error('Debate not found');

		const turns = await request.supabaseClient
			.from('turns')
			.select('*')
			.eq('debate_id', debateId)
			.order('order_number', { ascending: true });

		if (turns.error) throw new Error(`Failed to fetch turns: ${turns.error.message}`);

		const context = new DebateContext(request, turnRequest, debate.data, turns.data);

		return context;
	}

	hasTurns = () => this.turns && this.turns.length > 0;

	async validate() {
		// Ensure user is available
		if (!this.turnRequest.userId && !this.request.user) {
			throw new Error('User not found');
		}

		// Always set the model to gpt-4-0125-preview
		this.model = 'gpt-4o-mini';
	}
}
