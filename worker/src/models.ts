const gpt4 = 'gpt-4';
const gpt4MaxTokens = 8192;
const gpt35 = 'gpt-3.5-turbo';
const gpt35MaxTokens = 4096;
const gpt3516k = 'gpt-3.5-turbo-16k';
const gpt3516kMaxTokens = 16384;

const validModels = [gpt35, gpt3516k, gpt4];
const freeModels = [gpt35, gpt3516k];

const maxTokensLookup: { [model: string]: number } = {
	gpt4: gpt4MaxTokens,
	gpt35: gpt35MaxTokens,
	gpt3516k: gpt3516kMaxTokens,
};

export { gpt4, gpt4MaxTokens, gpt35, gpt35MaxTokens, gpt3516k, gpt3516kMaxTokens, validModels, freeModels, maxTokensLookup };
