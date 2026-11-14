// Picks the chat model from the environment. Everything else in src/ai/ is provider-agnostic.
export async function createModelFromEnv(env = process.env) {
  const provider = env.AI_PROVIDER ?? (env.GOOGLE_API_KEY ? 'google' : 'anthropic');

  if (provider === 'google') {
    const { ChatGoogleGenerativeAI } = await import('@langchain/google-genai');
    return new ChatGoogleGenerativeAI({
      model: env.AI_MODEL ?? 'gemini-3.8-flash', // check Google AI Studio for the current Flash-class name
      temperature: 0,
      maxOutputTokens: 2048, // generous: some Gemini models spend output tokens on "thinking" first
      maxRetries: 1,
    });
  }

  const { ChatAnthropic } = await import('@langchain/anthropic');
  return new ChatAnthropic({
    model: env.AI_MODEL ?? 'claude-haiku-5-5', temperature: 0, maxTokens: 1024, maxRetries: 1,
  });
}