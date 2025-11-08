import { Client } from 'pg'
import 'dotenv/config'

async function ensureDb () {
  const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: +(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: 'postgres', // connect to default DB
  })

  const dbName = process.env.DB_NAME || 'postgres'
  await client.connect()

  const res = await client.query(
    `SELECT 1 FROM pg_database WHERE datname = $1`,
    [dbName],
  )
  if (res.rowCount === 0) {
    console.log(`⚙️ Creating database '${dbName}'...`)
    await client.query(`CREATE DATABASE "${dbName}"`)
    console.log(`Database '${dbName}' created successfully.`)
  } else {
    console.log(`Database '${dbName}' already exists.`)
  }

  await client.end()
}

ensureDb()
