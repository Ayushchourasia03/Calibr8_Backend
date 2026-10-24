import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import indexRouter from './routers/index.router.js';
import { errorHandler } from './middlewares/error.middleware.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Security headers: strict CSP, framing protection, MIME sniffing protection
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline' https:; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: https:; font-src 'self' https:; connect-src 'self' https:; frame-ancestors 'self' https://*.run.app https://*.google.com;"
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// CORS - allow configured FRONTEND_URL or allow all origins in dev preview
app.use(
  cors({
    origin: process.env.FRONTEND_URL ? process.env.FRONTEND_URL.split(',').map((u) => u.trim()) : true,
    credentials: true,
  })
);

// Body parsing with size limit
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Serve static assets from public/
app.use(express.static(path.join(__dirname, '../public')));

// All routes
app.use('/', indexRouter);

// Global error handler (must be last)
app.use(errorHandler);

export default app;