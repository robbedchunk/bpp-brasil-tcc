import { Store } from '../entities/store.entity'
import { AppDataSource } from '../../data-source'

const stores = [
  {
    name: 'Extra Supermercado',
    baseUrl: 'https://www.extra.com.br/',
    zipcode: 1000000,
  },
  {
    name: 'Atacadão',
    baseUrl: 'https://www.atacadao.com.br/',
    zipcode: 1000000,
  },
  {
    name: 'mercado carrefour',
    baseUrl: 'https://mercado.carrefour.com.br',
    zipcode: 1000000,
  },
];

const old_stores = [
  {
    name: 'Extra Supermercado',
    sourceUrl: 'https://www.extra.com.br/',
    zipcode: 1000000,
  },
  {
    name: 'Atacadão',
    sourceUrl: 'https://www.atacadao.com.br/',
    zipcode: 1000000,
  },
  {
    name: 'mercado carrefour',
    sourceUrl: 'mercado.carrefour.com.br',
    zipcode: 1000000,
  },
  {
    name: 'Muffato (Super Muffato)',
    sourceUrl: 'https://www.supermuffato.com.br/',
    zipcode: 80000000,
    // active: 0,
  },
  {
    name: 'iFood',
    sourceUrl: 'https://www.ifood.com.br/',
    zipcode: 1000000,
    // active: 0,
  },
  {
    name: 'Rappi',
    sourceUrl: 'https://www.rappi.com.br/',
    zipcode: 1000000,
    // active: 0,
  },
  {
    name: 'Americanas',
    sourceUrl: 'https://www.americanas.com.br/',
    zipcode: 1000000,
    // active: 0,
  },
]

async function seed () {
  const dataSource = await AppDataSource.initialize()
  const repo = dataSource.getRepository(Store)

  console.log('Seeding database...')
  for (const s of stores) {
    const exists = await repo.findOne({ where: { name: s.name } })
    if (!exists) await repo.save(repo.create(s))
  }
  console.log('Done seeding.')
  await dataSource.destroy()
}

seed().catch(console.error)
