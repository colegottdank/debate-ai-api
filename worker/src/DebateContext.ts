import { Database } from './database.types';
import { RequestWrapper } from './worker';
import { FunctionModel, Model, gpt3516k_0125, gpt3516k_0613, isValidModel } from './models';
import { determineModel } from './Util';

export interface Turn {
	userId: string;
	argument: string;
	speaker: 'user' | 'AI' | 'AI_for_user';
	model: Model | FunctionModel;
}

export class DebateContext {
	request: RequestWrapper;
	turn: Turn;
	debate: Database['public']['Tables']['debates']['Row'];
	turns: Database['public']['Tables']['turns']['Row'][] | undefined;
	userId: string | undefined;
	model: FunctionModel = gpt3516k_0613;

	private constructor(
		request: RequestWrapper,
		debate: Database['public']['Tables']['debates']['Row'],
		turns: Database['public']['Tables']['turns']['Row'][] | undefined,
		turn: Turn
	) {
		this.request = request;
		this.debate = debate;
		this.turns = turns;
		this.turn = turn;
		this.userId = request.user?.id ?? turn.userId;
	}

	static async create(request: RequestWrapper, debateId: string): Promise<DebateContext> {
		let debatePromise = request.db.getDebate(debateId);
		let turnsPromise = request.db.getTurns(debateId);
		let turnPromise: Promise<Turn> = request.json() as Promise<Turn>;

		let [debate, turns, turn] = await Promise.all([debatePromise, turnsPromise, turnPromise]);

		const context = new DebateContext(request, debate, turns, turn);
		await context.determineModelTurn();

		return context;
	}

	async determineModelTurn(): Promise<void> {
		// Ensure user is available
		if (!this.turn?.userId && !this.request.user) {
			throw new Error('User not found');
		}

		let model: Model | FunctionModel;

		if (this.turn?.model) {
			model = this.turn.model;
		} else {
			if (isValidModel(this.debate.model)) {
				model = this.debate.model as Model | FunctionModel;
			} else {
				console.error(`Invalid model from debate ${this.debate.id}: ${this.debate.model}`);
				model = gpt3516k_0125;
			}
		}

		this.model = determineModel(model, this.request.user, this.request.profile);

		if (this.request.profile && (this.request.profile.pro_trial_count < 5 || this.request.profile.plan === 'pro')) {
			await this.request.db.updateProTrialCount(this.request.profile);
		}
	}
}
