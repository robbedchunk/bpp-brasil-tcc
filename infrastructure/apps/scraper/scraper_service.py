import asyncio
from db import get_conn
from crawler import crawl_domain
from log_utils import log_message


async def get_proxies(conn):
    rows = await conn.fetch('SELECT ip, port, username, pass FROM proxy')
    proxies = []
    for r in rows:
        auth = f"{r['username']}:{r['pass']}@" if r['username'] else ''
        proxies.append(f"http://{auth}{r['ip']}:{r['port']}")
    return proxies


async def run_scrape():
    conn = await get_conn()
    proxies = await get_proxies(conn)

    # camelCase column names must be quoted
    run_id = await conn.fetchval("""
        INSERT INTO scrape_run ("startedAt", status)
        VALUES (now(), 'running')
        RETURNING id
    """)

    # store table uses "baseUrl"
    stores = await conn.fetch('SELECT id, "baseUrl" FROM store WHERE active = TRUE')

    for store in stores:
        print(f"Scraping {store['baseUrl']}...")
        links = await crawl_domain(store['baseUrl'], proxies)

        for link in links:
            try:    
                # scrape table uses camelCase fields
                await conn.execute("""
                    INSERT INTO scrape (
                        scrape_run_id,
                        store_id,
                        type,
                        "sourceUrl",
                        status,
                        "startedAt"
                    )
                    VALUES ($1, $2, 'frontpage', $3, 'success', now())
                    ON CONFLICT DO NOTHING
                """, run_id, store['id'], link)
            except Exception as e:
                await log_message(None, "ERROR", f"Failed to insert scrape for {link}: {e}")
                continue


    # Update scrape_run with camelCase columns
    await conn.execute("""
        UPDATE scrape_run
        SET status = 'finished',
            "finishedAt" = now()
        WHERE id = $1
    """, run_id)

    await conn.close()
    print(f"Scrape run {run_id} complete.")
