#!/usr/bin/env python3
"""
Carrefour Product Discovery - Final Version

Gets all products from relevant categories, then extracts product details
to filter for specific search terms like "Leite Integral"
"""

import json
import asyncio
from pathlib import Path
from typing import List, Dict
from urllib.parse import urljoin, urlparse
from crawl4ai import (
    AsyncWebCrawler,
    CrawlerRunConfig,
    BrowserConfig,
    CacheMode
)
from bs4 import BeautifulSoup


async def discover_carrefour_products(search_term: str = "leite integral") -> List[str]:
    """
    Discover products on Carrefour matching search term

    Args:
        search_term: Product to search for (e.g., "leite integral")

    Returns:
        List of product URLs
    """
    base_url = "https://mercado.carrefour.com.br"

    # Direct category URLs for dairy/beverages
    category_urls = [
        f"{base_url}/laticin", # Dairy
        f"{base_url}/mercearia",  # Grocery
        f"{base_url}/bebidas",  # Beverages
    ]

    print(f"\n{'='*80}")
    print(f"🔍 Searching Carrefour for: {search_term}")
    print(f"{'='*80}\n")

    all_products = {}  # URL -> product info

    browser_config = BrowserConfig(
        headless=False,
        java_script_enabled=True,
        verbose=True
    )

    async with AsyncWebCrawler(config=browser_config) as crawler:
        for category_url in category_urls:
            print(f"\n📂 Category: {category_url}")

            # Load category with scrolling
            config = CrawlerRunConfig(
                cache_mode=CacheMode.BYPASS,
                delay_before_return_html=5,
                verbose=True
            )

            try:
                result = await crawler.arun(url=category_url, config=config)

                if not result.success:
                    print(f"  ✗ Failed: {result.error_message}")
                    continue

                print(f"  ✓ Loaded")

                # Parse HTML to extract ALL products (not just those with search term in URL)
                soup = BeautifulSoup(result.html, 'html.parser')

                # Find product cards - Carrefour uses specific elements
                product_cards = soup.find_all(['article', 'div'], attrs={
                    'data-testid': lambda x: x and 'product' in str(x).lower()
                })

                if not product_cards:
                    # Try alternative selectors
                    product_cards = soup.find_all('article')

                print(f"  📦 Found {len(product_cards)} product cards")

                # Debug: Save first card HTML
                if product_cards and category_url.endswith('laticin'):
                    debug_dir = Path("debug_output")
                    debug_dir.mkdir(exist_ok=True)
                    with open(debug_dir / "first_product_card.html", "w", encoding="utf-8") as f:
                        f.write(str(product_cards[0].prettify()))
                    print(f"  🐛 Saved first card to debug_output/first_product_card.html")

                links_found = 0
                for card in product_cards:
                    # Find product link - try multiple strategies
                    link = card.find('a', href=lambda x: x and '/p' in str(x))

                    if not link:
                        # Try finding any link with href
                        link = card.find('a', href=True)

                    if not link:
                        continue

                    links_found += 1
                    href = link.get('href', '')

                    # Accept links ending with /p or containing /p/
                    if not ('/p' in href):
                        continue

                    # Get product title
                    title = ''
                    title_elem = (
                        card.find('h3') or
                        card.find(['span', 'a'], {'title': True}) or
                        link
                    )
                    if title_elem:
                        title = title_elem.get('title', '') or title_elem.get_text(strip=True)

                    # Make absolute URL
                    abs_url = urljoin(base_url, href)
                    parsed = urlparse(abs_url)
                    clean_url = f"{parsed.scheme}://{parsed.netloc}{parsed.path}"

                    # Store product info
                    if clean_url not in all_products:
                        all_products[clean_url] = {
                            'url': clean_url,
                            'title': title,
                            'slug': href
                        }

                print(f"  🔗 Links found in cards: {links_found}")
                print(f"  ✓ Total unique products: {len(all_products)}")

            except Exception as e:
                print(f"  ✗ Error: {e}")
                continue

    # Filter products by search term
    search_terms = search_term.lower().split()
    matching_products = []

    for product in all_products.values():
        title_lower = product['title'].lower()
        slug_lower = product['slug'].lower()

        # Check if any search term is in title or slug
        matches = any(term in title_lower or term in slug_lower for term in search_terms)

        if matches:
            matching_products.append(product)

    print(f"\n{'='*80}")
    print(f"✅ Discovery Complete!")
    print(f"  Total products found: {len(all_products)}")
    print(f"  Matching '{search_term}': {len(matching_products)}")
    print(f"{'='*80}\n")

    # Display results
    if matching_products:
        print(f"🥛 Products matching '{search_term}':\n")
        for i, product in enumerate(matching_products, 1):
            print(f"{i}. {product['title']}")
            print(f"   {product['url']}\n")
    else:
        print(f"⚠️  No products found matching '{search_term}'")
        print(f"\nShowing some products found in categories:")
        for i, product in enumerate(list(all_products.values())[:10], 1):
            print(f"{i}. {product['title']}")
            print(f"   {product['url']}\n")

    # Save results
    output_file = "carrefour_products_" + search_term.replace(' ', '_') + ".json"
    data = {
        "search_term": search_term,
        "total_found": len(all_products),
        "matching_products": len(matching_products),
        "products": [p['url'] for p in matching_products],
        "product_details": matching_products
    }

    with open(output_file, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

    print(f"💾 Results saved to {output_file}\n")

    return [p['url'] for p in matching_products]


async def main():
    # Search for "Leite Integral" (whole milk)
    products = await discover_carrefour_products("leite integral")

    if products:
        print(f"✅ Success! Found {len(products)} product URLs for whole milk")
    else:
        print("❌ No whole milk products found")
        print("\nThis could be because:")
        print("  1. Carrefour requires location (CEP) to be set")
        print("  2. Products are loaded dynamically after more interaction")
        print("  3. Different category URLs are needed")


if __name__ == "__main__":
    asyncio.run(main())
