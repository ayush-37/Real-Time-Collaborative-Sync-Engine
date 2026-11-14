import { createAiService } from './service.js';
import 'dotenv/config';
export async function createAiFromEnv(env = process.env) {
  if (!env.GOOGLE_API_KEY && !env.ANTHROPIC_API_KEY) {
    console.log('[ai] no API key set: AI review is OFF');
    return null;
  }
  const { createModelFromEnv } = await import('./model.js');
  const { createChains } = await import('./chains.js');
  console.log('[ai] AI review is ON');
  return createAiService({ chains: createChains({ model: await createModelFromEnv(env) }) });
}