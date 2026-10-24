import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import healthRouter from './routes/health.js';
import publicRouter from './routes/public.js';
import authRouter from './auth/routes.js';
import accessRouter from './auth/accessRoutes.js';
import adminRouter from './routes/admin.js';
import submissionsRouter from './routes/submissions.js';
import reviewsRouter from './routes/reviews.js';
import registrationsRouter from './routes/registrations.js';
import schedulesRouter from './routes/schedules.js';
import certificatesRouter from './routes/certificates.js';
import notificationsRouter from './routes/notifications.js';
import analyticsRouter from './routes/analytics.js';
import { loadSession } from './auth/middleware.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

export function createApp() {
  const app = express();
  const proxyHops = Number.parseInt(process.env.TRUST_PROXY_HOPS || '0', 10);
  if (process.env.NODE_ENV === 'production' && (!process.env.CSRF_SECRET || process.env.CSRF_SECRET.length < 32)) {
    throw new Error('Set CSRF_SECRET to a random value of at least 32 characters in production.');
  }
  app.disable('x-powered-by');
  app.set('trust proxy', Number.isInteger(proxyHops) && proxyHops > 0 ? proxyHops : false);
  app.use(helmet());
  app.use(cors({ origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173', credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', loadSession);
  app.use('/api', healthRouter);
  app.use('/api/auth', authRouter);
  app.use('/api', submissionsRouter);
  app.use('/api', reviewsRouter);
  app.use('/api', registrationsRouter);
  app.use('/api', schedulesRouter);
  app.use('/api', certificatesRouter);
  app.use('/api', notificationsRouter);
  app.use('/api/admin', analyticsRouter);
  app.use('/api', accessRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api', publicRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
