import { Router } from 'express';
import { pool } from '../db';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { authenticate, tokenBlacklist } from '../middleware/auth';
import crypto from 'crypto';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_key';

// POST /auth/login — Authenticate with email + password
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  try {
    const result = await pool.query(
      'SELECT id, email, password_hash, name, role, department_id, can_create_projects, is_active FROM users WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const user = result.rows[0];

    if (!user.is_active) {
      return res.status(403).json({ error: 'Your account has been deactivated. Contact your administrator.' });
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const tokenPayload = {
      id: user.id,
      role: user.role,
      email: user.email,
      name: user.name,
      department_id: user.department_id,
      can_create_projects: user.can_create_projects,
    };

    const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '12h' });

    const { password_hash, ...safeUser } = user;
    res.json({ token, user: safeUser });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
});

// GET /auth/me — Return current user profile from token
router.get('/me', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.email, u.name, u.role, u.department_id, u.can_create_projects, u.is_active, u.manager_id,
              d.name as department_name, d.code as department_code,
              m.name as manager_name
       FROM users u
       LEFT JOIN departments d ON u.department_id = d.id
       LEFT JOIN users m ON u.manager_id = m.id
       WHERE u.id = $1`,
      [req.user!.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Auth/me error:', err);
    res.status(500).json({ error: 'Failed to fetch user profile.' });
  }
});

// POST /auth/logout — Invalidate token server-side
router.post('/logout', authenticate, (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (token) {
    tokenBlacklist.add(token);
  }
  res.json({ message: 'Logged out successfully.' });
});

// POST /auth/forgot-password — Send reset link (stubbed)
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'Email is required.' });
  }

  try {
    const result = await pool.query('SELECT id, name FROM users WHERE email = $1 AND is_active = true', [email]);
    if (result.rows.length === 0) {
      // Don't reveal if email exists or not
      return res.json({ message: 'If an account exists with that email, a reset link has been sent.' });
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    // In production: store resetToken + expiry in DB, send email with link
    console.log(`[EMAIL STUB] Password reset for ${email}: token=${resetToken}`);

    res.json({ message: 'If an account exists with that email, a reset link has been sent.' });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: 'An unexpected error occurred.' });
  }
});

// POST /auth/reset-password — Validate token and set new password (stubbed)
router.post('/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) {
    return res.status(400).json({ error: 'Token and new password are required.' });
  }

  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters long.' });
  }

  // In production: validate token from DB, check expiry
  // For now, stub response
  console.log(`[EMAIL STUB] Password reset with token: ${token}`);
  res.json({ message: 'Password has been reset successfully. Please log in with your new password.' });
});

export default router;
