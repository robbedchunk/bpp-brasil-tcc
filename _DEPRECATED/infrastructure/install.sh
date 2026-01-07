#!/bin/bash
# run this script from the root of the project
docker network create inflation_net
docker compose build --no-cache
docker compose up -d

# testout: open in browser
# curl http://localhost:3000

# stop
# docker compose down