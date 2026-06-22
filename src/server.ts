import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is not set.');
  process.exit(1);
}

import authRoutes from './routes/auth';
import timesheetRoutes from './routes/timesheets';
import approvalRoutes from './routes/approvals';
import userRoutes from './routes/users';
import projectRoutes from './routes/projects';
import holidayRoutes from './routes/holidays';
import departmentRoutes from './routes/departments';
import dailyLogRoutes from './routes/dailyLogs';
import financeRoutes from './routes/finance';
import notificationRoutes from './routes/notifications';
import accountingPeriodRoutes from './routes/accountingPeriods';
import adminRoutes from './routes/admin';
import reportsRoutes from './routes/reports';
import activityRoutes from './routes/activities';
import { startNotificationJobs } from './services/notificationService';

const app = express();
const port = process.env.PORT || 3000;

const allowedOrigins = [
  'https://oriental-energy-frontend.onrender.com',
  'http://localhost:5173',
  'http://localhost:4173',
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS blocked: ${origin}`));
    }
  },
  credentials: true,
}));
app.use(express.json());

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/timesheets', timesheetRoutes);
app.use('/api/v1/approvals', approvalRoutes);
app.use('/api/v1/users', userRoutes);
app.use('/api/v1/projects', projectRoutes);
app.use('/api/v1/holidays', holidayRoutes);
app.use('/api/v1/departments', departmentRoutes);
app.use('/api/v1/daily-logs', dailyLogRoutes);
app.use('/api/v1/finance', financeRoutes);
app.use('/api/v1/notifications', notificationRoutes);
app.use('/api/v1/accounting-periods', accountingPeriodRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/reports', reportsRoutes);
app.use('/api/v1/activities', activityRoutes);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', version: 'v5.0', timestamp: new Date().toISOString() });
});

app.listen(port, () => {
  console.log(`[Oriental Energy TMS] Server running on port ${port}`);
  startNotificationJobs();
});
