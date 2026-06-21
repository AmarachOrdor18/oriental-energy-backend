import { pool } from './index';
import fs from 'fs';
import path from 'path';

async function setup() {
  try {
    console.log('Reading schema.sql...');
    const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    
    console.log('Dropping existing tables...');
    await pool.query(`
      DROP TABLE IF EXISTS daily_logs CASCADE;
      DROP TABLE IF EXISTS timesheet_entries CASCADE;
      DROP TABLE IF EXISTS timesheets CASCADE;
      DROP TABLE IF EXISTS projects CASCADE;
      DROP TABLE IF EXISTS public_holidays CASCADE;
      DROP TABLE IF EXISTS accounting_periods CASCADE;
      DROP TABLE IF EXISTS notifications CASCADE;
      DROP TABLE IF EXISTS users CASCADE;
      DROP TABLE IF EXISTS departments CASCADE;
    `);

    console.log('Applying schema to AWS RDS...');
    await pool.query(schemaSql);
    
    console.log('Schema applied successfully!');
  } catch (err) {
    console.error('Error applying schema:', err);
  } finally {
    process.exit();
  }
}

setup();
