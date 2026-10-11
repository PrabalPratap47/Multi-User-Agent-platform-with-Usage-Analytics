import express from 'express';
import cors from 'cors';
import config from './config/env.js';
import { requestLogger } from './middleware/loggingMiddleware.js';
import { errorHandler } from './middleware/errorHandler.js';
import authRoutes from './routes/auth.js';
import cvRoutes from './routes/cv.js';
import analyticsRoutes from './routes/analytics.js';
import importRoutes from './routes/import.js';
import usersRoutes from './routes/users.js';
import usageLogsRoutes from './routes/usageLogs.js';
import sentimentRoutes from './routes/sentiment.js';
import runsRoutes from './routes/runs.js';
import skillsGapRoutes from './routes/skillsGap.js';



const app = express();
app.disable('x-powered-by');

app.get('/', (_req, res) => {
  res.json({status: 'ok', message: 'Server is running'});
});
app.get('/health', (_req, res) => {
  res.json({status: 'ok', message: 'Server is healthy'});
});

// Middleware
app.use(cors({
  origin: config.FRONTEND_URL,
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Logging
app.use(requestLogger);

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/cv', cvRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/import', importRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/usage-logs', usageLogsRoutes);
app.use('/api/sentiment', sentimentRoutes);
app.use('/api/runs', runsRoutes);
app.use('/api/skills-gap', skillsGapRoutes);

// 404 handler
app.use((_req, res) => {
  res.status(404).json({
    success: false,
    error: 'Not found',
  });
});

// Error handler (must be last)
app.use(errorHandler);

export default app;
