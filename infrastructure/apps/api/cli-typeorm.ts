/**
 * Unified TypeORM CLI launcher for PNPM + TS + ESM.
 * Works both locally (Mac) and inside Docker.
 */
import 'dotenv/config';
import 'reflect-metadata';
import { AppDataSource } from './src/database/data-source';

AppDataSource.initialize()
  .then(() => {
    console.log('✅ DataSource initialized for migrations');
  })
  .catch((err) => {
    console.error('❌ Failed to initialize DataSource', err);
    process.exit(1);
  });
