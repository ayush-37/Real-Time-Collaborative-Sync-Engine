// Builds the AI service from the environment. No API key = AI is OFF and the server runs as before.
import { createAiService } from './service.js';

export async function createAiFromEnv(env = process.env) {
  if (!env.ANTHROPIC_API_KEY) {
    console.log('[ai] ANTHROPIC_API_KEY not set: AI review is OFF');
    return null;
  }
  const { createChains } = await import('./chains.js'); // loads LangChain only when it is needed
  console.log('[ai] AI review is ON');
  return createAiService({ chains: createChains() });
}