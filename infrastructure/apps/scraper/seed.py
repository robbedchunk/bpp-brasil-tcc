from db import get_conn

async def seed_stores():
    stores = [
        {
            "name": "Extra Supermercado",
            "domain": "extra.com.br",
            "baseUrl": "https://www.extra.com.br/",
            "countryCode": "BR",
            "channel": "online",
        },
        {
            "name": "Atacadão",
            "domain": "atacadao.com.br",
            "baseUrl": "https://www.atacadao.com.br/",
            "countryCode": "BR",
            "channel": "online",
        },
        {
            "name": "Mercado Carrefour",
            "domain": "mercado.carrefour.com.br",
            "baseUrl": "https://mercado.carrefour.com.br/",
            "countryCode": "BR",
            "channel": "online",
        },
    ]

    conn = await get_conn()

    for store in stores:
        existing = await conn.fetchval(
            'SELECT id FROM store WHERE LOWER(name) = LOWER($1)', store["name"]
        )
        if not existing:
            await conn.execute(
                '''
                INSERT INTO store (name, domain, "baseUrl", "countryCode", channel)
                VALUES ($1, $2, $3, $4, $5)
                ''',
                store["name"],
                store["domain"],
                store["baseUrl"],
                store["countryCode"],
                store["channel"],
            )
            print(f"✅ Seeded store: {store['name']}")
        else:
            print(f"ℹ️ Store already exists: {store['name']}")

    await conn.close()
