import 'dotenv/config';
import app from './app.js';
import prisma from './config/db.js';

const PORT = 3000;

let server;
let shuttingDown = false;

async function startServer() {
  if (process.env.DATABASE_URL) {
    try {
      await prisma.$connect();
      console.log('✅ Connected to database');
    } catch (error) {
      console.warn('⚠️ Database connection warning:', error.message);
    }
  } else {
    console.warn('ℹ️ DATABASE_URL is not set. Set DATABASE_URL in .env to connect to your PostgreSQL database.');
  }

  server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running at http://0.0.0.0:${PORT}`);
  });

  server.on('error', (error) => {
    console.error('❌ Server error:', error.message);
    process.exitCode = 1;
  });

  server.on('close', () => {
    console.log('🛑 HTTP server closed');
  });
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`\n⚠️ ${signal} received. Shutting down gracefully...`);

  if (server?.listening) {
    server.close();
  }

  try {
    await prisma.$disconnect();
    console.log('🔌 Database disconnected');
  } catch (error) {
    console.error('⚠️ Database disconnect error:', error.message);
  }

  console.log('✅ Shutdown complete');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

startServer();
