import { Database } from './database.types';
import { RequestWrapper } from './worker';
import { freeModels, validModels } from './models';

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

		if (turns.error) throw new Error(turns.error.message);

		const context = new DebateContext(request, turnRequest, debate.data, turns.data);

		return context;
	}

	async validate() {
		const model = this.turnRequest.model ?? this.debate.model;
		if (!this.turnRequest.userId && !this.request.user) throw new Error('User not found');

		if (this.turnRequest.heh) return; // Validate model override

		// Validate model
		if (!validModels.includes(model)) throw new Error('Not a valid model');

		if (!freeModels.includes(model)) {
			if (!this.request.user || !this.request.profile) throw new Error('Not a valid model for anonymous users');

			if (this.request.profile.pro_trial_count < 5) {
				await this.request.supabaseClient
					.from('profiles')
					.update({ pro_trial_count: this.request.profile.pro_trial_count + 1 })
					.eq('id', this.request.profile.id);
				return;
			}
			if (this.request.profile.plan != 'pro') throw new Error('Not a valid model for free users');
		}
	}
}