import 'dotenv/config';
import { createModelFromEnv } from '../src/ai/model.js';

console.log({
  provider: process.env.AI_PROVIDER ?? '(auto)',
  hasGoogleKey: Boolean(process.env.GOOGLE_API_KEY),
  hasAnthropicKey: Boolean(process.env.ANTHROPIC_API_KEY),
  model: process.env.AI_MODEL ?? '(default)',
});

const t0 = Date.now();
try {
  const model = await createModelFromEnv();
  const r = await model.invoke('Reply with the single word: pong', { signal: AbortSignal.timeout(60_000) });
  console.log('OK', Date.now() - t0, 'ms ->', r.content);
} catch (e) {
  console.log('FAIL', Date.now() - t0, 'ms | status:', e.status, '| message:', e.message);
}