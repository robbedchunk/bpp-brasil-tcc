import { AppDataSource } from '../database/data-source'

async function resetDb () {
  await AppDataSource.initialize()
  console.log('Dropping schema...')
  await AppDataSource.dropDatabase()
  console.log('Synchronizing...')
  await AppDataSource.synchronize()
  console.log('Database re-initialized')
  process.exit(0)
}
resetDb()
