#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CRAWLER_WORKER_DIR="$SCRIPT_DIR/../crawler-worker"
CRAWLERS_DIR="$CRAWLER_WORKER_DIR/src/crawlers"
GUIDE_PATH="$CRAWLERS_DIR/IMPLEMENTING_A_CRAWLER.md"

# Validate input
WEBSITE_URL=$1
if [ -z "$WEBSITE_URL" ]; then
  echo "Usage: ./create-crawler.sh <website-url>"
  echo "Example: ./create-crawler.sh https://www.carrefour.com.br"
  exit 1
fi

# Extract domain for naming
DOMAIN=$(echo "$WEBSITE_URL" | sed -E 's|https?://([^/]+).*|\1|' | sed 's/www\.//')
CRAWLER_NAME=$(echo "$DOMAIN" | sed 's/\.com\.br//' | sed 's/\.com//' | sed 's/\./-/g')
CRAWLER_DIR="$CRAWLERS_DIR/$CRAWLER_NAME"

echo "Creating crawler PRD for: $WEBSITE_URL"
echo "Crawler name: $CRAWLER_NAME"
echo "Crawler dir: $CRAWLER_DIR"
echo ""

# Run Claude with Chrome for exploration + PRD creation
claude --chrome --permission-mode acceptEdits "
You are creating a PRD for a category crawler for: $WEBSITE_URL
Crawler name: $CRAWLER_NAME

## REFERENCE
Read the implementation guide: @$GUIDE_PATH

## END GOAL
Build a system capable of extracting ALL visible products from this merchant's website.

The crawler must be able to:
- Discover every product category
- Visit every category and collect every product URL
- Extract detailed product data from each product page

## YOUR TASK
Figure out the best way to achieve this and document it in a PRD.

## WHAT YOU NEED TO DISCOVER

1. **How to get all categories** - Could be from the nav menu, an API endpoint, a sitemap, etc.

2. **How to get products from a category** - Could be HTML scraping, API calls, GraphQL, etc.

3. **How pagination works** - URL params, API pagination, infinite scroll, load more button, etc.

4. **How to get product details** - JSON-LD on page, API endpoint, HTML parsing, etc.

## HOW TO EXPLORE

Use Chrome freely.

The goal is to find the EASIEST and most RELIABLE way to extract:
- Category URLs/names
- Product URLs from category pages
- Product data (name, price, images, GTIN)

## DELIVERABLES

1. Create folder $CRAWLER_DIR

2. Create $CRAWLER_DIR/prd.json with your findings as test-driven tasks:

[
  {
    \"category\": \"functional\",
    \"description\": \"What needs to work\",
    \"steps\": [
      \"How to verify it works - be specific about what you found\"
    ],
    \"passes\": false
  }
]

Include tasks for:
- Category discovery (document the approach you found)
- Product listing extraction (document the approach you found)
- Pagination handling (document how it works)
- Product detail extraction (document the approach you found)
- Tests and registration

3. Create empty $CRAWLER_DIR/progress.txt

## KEY POINT
Document what YOU discovered works best. Don't assume HTML scraping - if there's a clean API, use that. If there's embedded JSON data, use that. Find the path of least resistance.

Start exploring.
"
