import dotenv from 'dotenv';
import { closeDatabasePool } from './src/db/index.ts';
import { SERVER_CONFIG } from './src/server/config.ts';
import { createArenaServer } from './src/server/createApp.ts';

dotenv.config();

async function bootstrap() {
  const server = await createArenaServer({
    enableViteMiddleware: true,
    enableBackgroundWorkers: false,
  });

  server.httpServer.listen(SERVER_CONFIG.PORT, '0.0.0.0', () => {
    console.log(
      `IPL Auction Arena server (${SERVER_CONFIG.INSTANCE_ID}) running on http://0.0.0.0:${SERVER_CONFIG.PORT}`
    );
    // Start advisory-lock scheduler and LISTEN/NOTIFY lazily AFTER HTTP server binds port 3000
    server.startBackgroundWorkers();
  });

  const gracefulShutdown = async (signal: string) => {
    console.log(`[Server] Received ${signal}. Shutting down gracefully...`);
    try {
      await server.shutdown();
      await closeDatabasePool();
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
}

bootstrap().catch((err) => {
  console.error('[Server] Fatal startup error:', err);
  process.exit(1);
});
