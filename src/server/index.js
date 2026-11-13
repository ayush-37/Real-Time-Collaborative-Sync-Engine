import { startSyncServer } from './server.js';
import { createAiFromEnv } from '../ai/setup.js';   // adjust the relative path to your file

const port = Number(process.env.PORT ?? 3000);
const ai = await createAiFromEnv();
const server = await startSyncServer({port,ai,});

console.log(`sync server listening on ws://localhost:${server.port}  (health: http://localhost:${server.port}/health)`);

process.on('SIGINT', async () => {
  await server.close();
  process.exit(0);
});