import { startSyncServer } from './server.js';

const port = Number(process.env.PORT ?? 3000);
const server = await startSyncServer({ port });
console.log(`sync server listening on ws://localhost:${server.port}  (health: http://localhost:${server.port}/health)`);

process.on('SIGINT', async () => {
  await server.close();
  process.exit(0);
});