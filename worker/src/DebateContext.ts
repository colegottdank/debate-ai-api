import { Database } from './database.types';
import { RequestWrapper } from './worker';
import { freeModels, gpt3516k, validModels } from './models';

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
	model: string = gpt3516k;

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
		const model = this.turnRequest.model ?? this.debate.model;

		// Ensure user is available
		if (!this.turnRequest.userId && !this.request.user) {
			throw new Error('User not found');
		}

		// Validate model, if invalid, use default gpt3516k
		if (!validModels.includes(model)) {
			console.error(`Invalid model for debate ${this.turnRequest.debateId}: ${model}`);
			this.model = gpt3516k;
			return;
		}

		// If the heh flag is set, simply return the model without further checks
		if (this.turnRequest.heh) {
			this.model = model;
		}

		// If user is using a free model, return the model
		if (freeModels.includes(model)) {
			this.model = model;
		} // If the user is on their free trial, increment the pro_trial_count and return the model
		else if (this.request.profile && (this.request.profile.pro_trial_count < 5 || this.request.profile.plan === 'pro')) {
			await this.request.supabaseClient
				.from('profiles')
				.update({ pro_trial_count: this.request.profile.pro_trial_count + 1 })
				.eq('id', this.request.profile.id);
			this.model = model;
		}

		// Otherwise, use default gpt3516k
	}
}
