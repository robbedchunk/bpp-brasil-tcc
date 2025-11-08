# installation

## init network

docker network create inflation_net

## run docker

docker compose up --build

# upon starting, check out the docs:

- http://localhost:3000/docs

# test redis:

docker exec -it redis redis-cli publish tasks "Hello from Redis"

# seed database

docker compose exec api pnpm --filter api run seed

# rebuild

docker compose down && docker compose build --no-cache && docker compose up

# dev,fast

rm -rf apps/api/dist && docker compose down && docker compose build && docker compose up

## just api

docker compose down && docker compose build --no-cache api && docker compose up

## direct pgadmin access (localhost:5050)

postgresql://postgres:postgres@ttinflation_db:5432/postgres
hostname: ttinflation_db
username: postgres
password: postgres
maintenance_database: postgres
database: postgres

# start/test fastpi_scraper

curl -X POST http://localhost:8000/scrape

###

https://github.com/robbedchunk/prices-inflation

http://pricesinflation:PmDN0c81NyHTf24p_country-br_session-3kPtIUit_lifetime-30m@geo.iproyal.com:12321

research papers
https://www.thebillionpricesproject.com/
https://www.aeaweb.org/articles?id=10.1257/jep.30.2.151
https://www.thebillionpricesproject.com/datasets/
https://www.pricestats.com/

Server setup
Setup Worker2: the worker that gets the pricing data from links in the SQL schema (Nodejs or Python)
Setup Worker1: the generalist worker that does deep crawling

# flow:

1. scraper_scheduler (cron) -> scraper (scrape) -> worker1 (crawler) -> worker2 (crawler)
