import { User } from '@supabase/supabase-js';
import { Database } from './database.types';
import { Model, FunctionModel, functionModelsMap, gpt3516k_0613, validModels, freeModels } from './models';

export function determineModel(
	model: Model | FunctionModel,
	user: User | null,
	profile: Database['public']['Tables']['profiles']['Row']
): FunctionModel {
	// Check if the model is valid and map it to its function model
	const functionModel = functionModelsMap[model] || gpt3516k_0613;

	if (!validModels.includes(model)) {
		console.error('Not a valid model, defaulted to gpt-3.5-turbo 16k');
		return functionModel;
	}

	if (freeModels.includes(model)) return functionModel;

	// If the user is on their free trial, return the function model
	if (user && profile && profile.plan === 'free' && profile.pro_trial_count < 5) {
		return functionModel;
	}

	if (!user || !profile?.plan || profile.plan !== 'pro') {
		return gpt3516k_0613; // Default to the 16k model if no user or not on pro plan
	}

	return functionModel;
}
