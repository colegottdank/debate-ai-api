const gpt4 = 'gpt-4';
const gpt35 = 'gpt-3.5-turbo';
const gpt3516k = 'gpt-3.5-turbo-16k';

const gpt4_0613 = 'gpt-4-0613';
const gpt35_0613 = 'gpt-3.5-turbo-0613';
const gpt3516k_0613 = 'gpt-3.5-turbo-16k-0613';
const gpt3516k_0125 = 'gpt-3.5-turbo-0125';

const gpt4MaxTokens = 8192;
const gpt35MaxTokens = 4096;
const gpt3516kMaxTokens = 16384;
const gpt3516k_0125MaxTokens = 16384;

const validModels = [gpt35, gpt3516k, gpt4, gpt35_0613, gpt3516k_0613, gpt3516k_0125, gpt4_0613];
const freeModels = [gpt35, gpt3516k, gpt35_0613, gpt3516k_0613, gpt3516k_0125];

type FunctionModel = typeof gpt4_0613 | typeof gpt35_0613 | typeof gpt3516k_0613 | typeof gpt3516k_0125;
type Model = typeof gpt4 | typeof gpt35 | typeof gpt3516k;

const functionModelsMap: { [key in Model | FunctionModel]?: FunctionModel } = {
	[gpt4]: gpt4_0613,
	[gpt4_0613]: gpt4_0613,
	[gpt35]: gpt35_0613,
	[gpt35_0613]: gpt35_0613,
	[gpt3516k]: gpt3516k_0613,
	[gpt3516k_0613]: gpt3516k_0613,
	[gpt3516k_0125]: gpt3516k_0125,
};

const maxTokensLookup: { [model: string]: number } = {
	gpt4: gpt4MaxTokens,
	gpt4_0613: gpt4MaxTokens,
	gpt35: gpt35MaxTokens,
	gpt35_0613: gpt35MaxTokens,
	gpt3516k: gpt3516kMaxTokens,
	gpt3516k_0613: gpt3516kMaxTokens,
	gpt3516k_0125: gpt3516k_0125MaxTokens,
};

function isValidModel(model: string): model is Model | FunctionModel {
	return validModels.includes(model as any);
}

export {
	gpt4,
	gpt4_0613,
	gpt4MaxTokens,
	gpt35,
	gpt35_0613,
	gpt35MaxTokens,
	gpt3516k,
	gpt3516k_0613,
	gpt3516kMaxTokens,
	gpt3516k_0125,
	gpt3516k_0125MaxTokens,
	validModels,
	freeModels,
	maxTokensLookup,
	functionModelsMap,
	isValidModel,
};

export type { FunctionModel, Model };
