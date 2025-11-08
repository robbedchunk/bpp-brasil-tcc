#!/usr/bin/env python3
"""
Carrefour Full Product Crawler

Discovers ALL categories and extracts ALL product URLs from Carrefour
"""

import json
import asyncio
from pathlib import Path
from typing import List, Set, Dict
from urllib.parse import urlparse, urljoin
from datetime import datetime
from crawl4ai import (
    AsyncWebCrawler,
    CrawlerRunConfig,
    BrowserConfig,
    CacheMode
)


class CarrefourFullCrawler:
    def __init__(self, base_url: str = "https://mercado.carrefour.com.br", max_concurrent: int = 50):
        self.base_url = base_url
        self.all_products: Set[str] = set()
        self.categories_found: Set[str] = set()
        self.progress_file = Path("carrefour_crawl_progress.json")
        self.results_file = Path("carrefour_all_products.json")
        self.max_concurrent = max_concurrent
        self.lock = asyncio.Lock()  # For thread-safe set operations

    async def save_progress(self):
        """Save current progress (thread-safe)"""
        async with self.lock:
            data = {
                "timestamp": datetime.now().isoformat(),
                "total_products": len(self.all_products),
                "categories_crawled": len(self.categories_found),
                "products": list(self.all_products),
                "categories": list(self.categories_found)
            }
            with open(self.progress_file, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
            print(f"  💾 Progress saved: {len(self.all_products)} products")

    def load_progress(self):
        """Load previous progress if exists"""
        if self.progress_file.exists():
            with open(self.progress_file, 'r', encoding='utf-8') as f:
                data = json.load(f)
                self.all_products = set(data.get("products", []))
                self.categories_found = set(data.get("categories", []))
                print(
                    f"  📂 Loaded progress: {len(self.all_products)} products from {len(self.categories_found)} categories")
                return True
        return False

    async def discover_categories(self, crawler: AsyncWebCrawler) -> List[str]:
        """Discover all category pages from homepage"""
        print("\n" + "="*80)
        print("🔍 STEP 1: Discovering Categories")
        print("="*80 + "\n")

        categories = set()

        config = CrawlerRunConfig(
            cache_mode=CacheMode.BYPASS,
            delay_before_return_html=3,
            verbose=True
        )

        result = await crawler.arun(url=self.base_url, config=config)

        if not result.success:
            print(f"❌ Failed to load homepage: {result.error_message}")
            return []

        print("✓ Homepage loaded")

        # Extract all internal links
        internal_links = result.links.get("internal", [])
        print(f"  Found {len(internal_links)} internal links")

        # Filter for category links
        for link in internal_links:
            href = link.get("href", "")

            # Category patterns
            is_category = any([
                # /category-name
                href.count('/') == 4 and not href.endswith('/p'),
                '/colecao/' in href,
                '/departamento/' in href,
                any(cat in href.lower() for cat in [
                    'mercearia', 'bebidas', 'laticinios', 'laticinio',
                    'alimentos', 'higiene', 'limpeza', 'perfumaria',
                    'bebe', 'infantil', 'pet', 'drogaria', 'farmacia',
                    'congelados', 'acougue', 'padaria', 'hortifruti'
                ])
            ])

            # Exclude non-category pages
            if is_category and not any(x in href for x in [
                '/p/', '/institucional/', '/atendimento/', '/search',
                'cadastre', 'login', 'account', 'cart', 'checkout'
            ]):
                parsed = urlparse(href)
                clean_url = f"{parsed.scheme}://{parsed.netloc}{parsed.path}"
                categories.add(clean_url)

        # Add known main categories
        known_categories = [
            '/mercearia', '/bebidas', '/laticinios', '/alimentos',
            '/higiene-e-perfumaria', '/limpeza', '/bebe-e-infantil',
            '/pet', '/home-drogaria', '/congelados'
        ]

        for cat in known_categories:
            categories.add(self.base_url + cat)

        categories_list = sorted(list(categories))

        print(f"\n✅ Found {len(categories_list)} categories:\n")
        for i, cat in enumerate(categories_list, 1):
            name = cat.split('/')[-1] or cat.split('/')[-2]
            print(f"  {i}. {name}")

        return categories_list

    async def crawl_category(self, crawler: AsyncWebCrawler, category_url: str, category_num: int, total_categories: int) -> int:
        """Crawl a single category and extract all product URLs"""
        category_name = category_url.split(
            '/')[-1] or category_url.split('/')[-2]

        print(f"\n{'─'*80}")
        print(f"📂 [{category_num}/{total_categories}] Crawling: {category_name}")
        print(f"{'─'*80}")

        session_id = f"carrefour_cat_{category_num}"
        products_before = len(self.all_products)

        try:
            # Initial load
            config = CrawlerRunConfig(
                session_id=session_id,
                cache_mode=CacheMode.BYPASS,
                delay_before_return_html=5,
                verbose=False
            )

            result = await crawler.arun(url=category_url, config=config)

            if not result.success:
                print(f"  ❌ Failed: {result.error_message}")
                return 0

            print(f"  ✓ Initial load complete")

            # Extract products from initial load
            await self._extract_products(result)
            async with self.lock:
                initial_count = len(self.all_products) - products_before
            print(f"  📦 Found {initial_count} products")

            # Scroll multiple times to load more products
            max_scrolls = 10
            no_new_products_count = 0

            for scroll in range(1, max_scrolls + 1):
                async with self.lock:
                    products_before_scroll = len(self.all_products)

                # Scroll and try to trigger load more
                scroll_js = """
                // Scroll to bottom
                window.scrollTo(0, document.body.scrollHeight);

                // Try to click "Ver mais" or "Carregar mais" button
                const buttons = document.querySelectorAll('button');
                for (const btn of buttons) {
                    const text = btn.textContent.toLowerCase();
                    if (text.includes('ver mais') ||
                        text.includes('carregar') ||
                        text.includes('mais produtos')) {
                        btn.click();
                        console.log('Clicked load more button');
                        break;
                    }
                }
                """

                scroll_config = CrawlerRunConfig(
                    session_id=session_id,
                    js_code=scroll_js,
                    js_only=True,
                    cache_mode=CacheMode.BYPASS,
                    delay_before_return_html=2,
                    verbose=False
                )

                result = await crawler.arun(url=category_url, config=scroll_config)

                if result.success:
                    await self._extract_products(result)
                    async with self.lock:
                        new_products = len(self.all_products) - \
                            products_before_scroll
                        total_so_far = len(self.all_products) - products_before

                    if new_products > 0:
                        print(
                            f"  📜 Scroll {scroll}/{max_scrolls}: +{new_products} products (total: {total_so_far})")
                        no_new_products_count = 0
                    else:
                        no_new_products_count += 1
                        if no_new_products_count >= 3:
                            print(f"  ⏸  No new products after 3 scrolls, stopping")
                            break
                else:
                    break

            async with self.lock:
                total_from_category = len(self.all_products) - products_before
                self.categories_found.add(category_url)
            print(
                f"  ✅ Category complete: {total_from_category} products total")

            await self.save_progress()

            return total_from_category

        except Exception as e:
            print(f"  ❌ Error: {e}")
            return 0

    async def _extract_products(self, result):
        """Extract product URLs from crawl result (thread-safe)"""
        internal_links = result.links.get("internal", [])

        new_products = set()
        for link in internal_links:
            href = link.get("href", "")

            # Carrefour product URLs end with /p
            if href.endswith("/p"):
                parsed = urlparse(href)
                clean_url = f"{parsed.scheme}://{parsed.netloc}{parsed.path}"
                new_products.add(clean_url)

        async with self.lock:
            self.all_products.update(new_products)

    async def crawl_category_with_semaphore(self, crawler: AsyncWebCrawler, category_url: str,
                                            category_num: int, total_categories: int, semaphore: asyncio.Semaphore):
        """Wrapper to crawl category with semaphore for concurrency control"""
        async with semaphore:
            return await self.crawl_category(crawler, category_url, category_num, total_categories)

    async def run(self):
        """Run full crawl"""
        print("\n" + "="*80)
        print("🚀 CARREFOUR FULL PRODUCT CRAWLER")
        print(f"⚡ Max concurrent categories: {self.max_concurrent}")
        print("="*80 + "\n")

        # Try to load previous progress
        had_progress = self.load_progress()

        browser_config = BrowserConfig(
            headless=False,
            java_script_enabled=True,
            verbose=True
        )

        async with AsyncWebCrawler(config=browser_config) as crawler:
            # Discover categories
            categories = await self.discover_categories(crawler)

            if not categories:
                print("❌ No categories found!")
                return

            print(f"\n" + "="*80)
            print(
                f"🔄 STEP 2: Crawling {len(categories)} Categories (in parallel)")
            print("="*80)

            # Filter out already crawled categories
            categories_to_crawl = [
                cat for cat in categories if cat not in self.categories_found]

            if not categories_to_crawl:
                print("\n✅ All categories already crawled!")
            else:
                print(f"\n📋 {len(categories_to_crawl)} categories to crawl")

                # Create semaphore for concurrency control
                semaphore = asyncio.Semaphore(self.max_concurrent)

                # Create tasks for all categories
                tasks = []
                for i, category_url in enumerate(categories_to_crawl, 1):
                    task = self.crawl_category_with_semaphore(
                        crawler, category_url, i, len(
                            categories_to_crawl), semaphore
                    )
                    tasks.append(task)

                # Run all categories in parallel (limited by semaphore)
                print(f"🚀 Starting parallel crawl...\n")
                results = await asyncio.gather(*tasks, return_exceptions=True)

                # Count successes
                success_count = sum(
                    1 for r in results if not isinstance(r, Exception))
                print(f"\n✅ Completed {success_count}/{len(tasks)} categories")

        # Final save
        print("\n" + "="*80)
        print("✅ CRAWL COMPLETE!")
        print("="*80 + "\n")
        print(f"  Total products discovered: {len(self.all_products)}")
        print(f"  Categories crawled: {len(self.categories_found)}")

        # Save final results
        final_data = {
            "timestamp": datetime.now().isoformat(),
            "total_products": len(self.all_products),
            "categories_count": len(self.categories_found),
            "products": sorted(list(self.all_products)),
            "categories": sorted(list(self.categories_found))
        }

        with open(self.results_file, 'w', encoding='utf-8') as f:
            json.dump(final_data, f, indent=2, ensure_ascii=False)

        print(f"\n  💾 Final results saved to: {self.results_file}")
        print(f"  💾 Progress file: {self.progress_file}\n")


async def main():
    """Main entry point - adjust max_concurrent to control parallelization"""
    crawler = CarrefourFullCrawler(
        max_concurrent=50)  # Increase for more parallelization
    await crawler.run()


if __name__ == "__main__":
    asyncio.run(main())
