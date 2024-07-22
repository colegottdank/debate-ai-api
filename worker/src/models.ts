const gpt4 = 'gpt-4';
const gpt4MaxTokens = 8192;
const gpt35 = 'gpt-3.5-turbo';
const gpt35MaxTokens = 4096;
// const gpt3516k = 'gpt-3.5-turbo-16k';
// const gpt3516kMaxTokens = 16384;
const gpt3516k_0125 = 'gpt-3.5-turbo-0125';
const gpt3516k_0125MaxTokens = 16384;
const gpt4o_mini = 'gpt-4o-mini';
const gpt4o_miniMaxTokens = 128000;

const validModels = [gpt35, gpt3516k_0125, gpt4, gpt4o_mini];
const freeModels = [gpt35, gpt3516k_0125];

const maxTokensLookup: { [model: string]: number } = {
	gpt4: gpt4MaxTokens,
	gpt35: gpt35MaxTokens,
	gpt3516k_0125: gpt3516k_0125MaxTokens,
};

export {
	gpt4,
	gpt4MaxTokens,
	gpt35,
	gpt35MaxTokens,
	gpt3516k_0125,
	gpt3516k_0125MaxTokens,
	gpt4o_mini,
	gpt4o_miniMaxTokens,
	validModels,
	freeModels,
	maxTokensLookup,
};
