import { Client } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// We need a separate connection to 'postgres' to create the new database
const connectionString = process.env.DATABASE_URL?.replace('/oriental_energy_tms', '/postgres');

async function init() {
  const client = new Client({
    connectionString,
    ssl: {
      rejectUnauthorized: false // Simplified for initial setup
    }
  });

  try {
    await client.connect();
    console.log('Connected to AWS RDS (postgres db)');
    
    await client.query('CREATE DATABASE oriental_energy_tms');
    console.log('Database oriental_energy_tms created successfully');
    
  } catch (err: any) {
    if (err.code === '42P04') {
      console.log('Database oriental_energy_tms already exists');
    } else {
      console.error('Error creating database:', err);
    }
  } finally {
    await client.end();
  }
}

init();
