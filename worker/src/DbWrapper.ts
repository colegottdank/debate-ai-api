import { SupabaseClient } from '@supabase/supabase-js';
import { Database } from './database.types';

export class DbWrapper {
	private supabaseClient: SupabaseClient<Database>;

	constructor(supabaseClient: SupabaseClient<Database>) {
		this.supabaseClient = supabaseClient;
	}

	async createDebate(debate: Database['public']['Tables']['debates']['Insert']): Promise<Database['public']['Tables']['debates']['Row']> {
		const newDebate = await this.supabaseClient.from('debates').insert(debate).select('*').single();

		if (newDebate.error) throw new Error(`Error occurred inserting new debate: ${newDebate.error.message}`);
		if (!newDebate.data) throw new Error('Debate not found');

		return newDebate.data;
	}

	async getDebate(debateId: string): Promise<Database['public']['Tables']['debates']['Row']> {
		const debate = await this.supabaseClient.from('debates').select('*').eq('id', debateId).single();

		if (debate.error) throw new Error(debate.error.message);
		if (!debate.data) throw new Error('Debate not found');

		return debate.data;
	}

	async getTurns(debateId: string): Promise<Database['public']['Tables']['turns']['Row'][]> {
		const turns = await this.supabaseClient.from('turns').select('*').eq('debate_id', debateId).order('order_number', { ascending: true });

		if (turns.error) throw new Error(turns.error.message);

		return turns.data;
	}

	async updateProTrialCount(profile: Database['public']['Tables']['profiles']['Row']): Promise<void> {
		const { error } = await this.supabaseClient
			.from('profiles')
			.update({ pro_trial_count: profile.pro_trial_count + 1 })
			.eq('id', profile.id);

		if (error) throw new Error(error.message);
	}
}
