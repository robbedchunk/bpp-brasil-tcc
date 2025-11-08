from db import get_conn
from datetime import datetime

async def log_message(scrape_id: int, level: str, message: str):
    """Insert a log entry linked to a scrape task."""
    conn = await get_conn()
    await conn.execute(
        '''
        INSERT INTO scrape_log (scrape_id, "logLevel", message, "createdAt")
        VALUES ($1, $2, $3, $4)
        ''',
        scrape_id, level, message, datetime.utcnow()
    )
    await conn.close()
