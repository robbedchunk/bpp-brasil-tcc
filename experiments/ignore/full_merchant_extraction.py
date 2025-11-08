#!/usr/bin/env python3
"""
Full Merchant Extraction Pipeline

Combines product link discovery with product data extraction:
1. Discovers ALL product URLs from merchant site
2. Extracts product data from each URL using cached schemas
3. Saves comprehensive results

Usage:
    python full_merchant_extraction.py --merchant "https://mercado.carrefour.com.br/" --max-products 50
"""

import asyncio
import argparse
import json
from pathlib import Path
from datetime import datetime
from typing import List, Dict, Any

from product_link_discovery import ProductLinkDiscovery, DiscoveryResult
from product_extraction_pipeline import ProductExtractionPipeline


class FullMerchantExtractor:
    """
    Complete extraction pipeline that discovers and extracts product data
    from any merchant website.
    """

    def __init__(
        self,
        api_token: str = "env:OPENAI_API_KEY",
        discovery_cache_dir: str = "./discovery_cache",
        extraction_cache_dir: str = "./schema_cache",
        output_dir: str = "./merchant_data"
    ):
        self.api_token = api_token
        self.discovery_cache_dir = Path(discovery_cache_dir)
        self.extraction_cache_dir = Path(extraction_cache_dir)
        self.output_dir = Path(output_dir)

        # Create directories
        self.discovery_cache_dir.mkdir(exist_ok=True)
        self.extraction_cache_dir.mkdir(exist_ok=True)
        self.output_dir.mkdir(exist_ok=True)

        self.discovery_service = None
        self.extraction_pipeline = None

    async def __aenter__(self):
        """Setup services"""
        self.discovery_service = ProductLinkDiscovery(
            cache_dir=str(self.discovery_cache_dir)
        )
        await self.discovery_service.__aenter__()

        self.extraction_pipeline = ProductExtractionPipeline(
            cache_dir=str(self.extraction_cache_dir),
            api_token=self.api_token
        )

        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Cleanup services"""
        if self.discovery_service:
            await self.discovery_service.__aexit__(exc_type, exc_val, exc_tb)

    async def extract_merchant(
        self,
        merchant_url: str,
        discovery_method: str = "auto",
        max_products: int = -1,
        max_urls_discovery: int = -1,
        sample_first: int = None
    ) -> Dict[str, Any]:
        """
        Complete extraction flow for a merchant.

        Args:
            merchant_url: Merchant website URL
            discovery_method: "auto", "url_seeding", or "deep_crawl"
            max_products: Maximum products to extract (-1 for all)
            max_urls_discovery: Maximum URLs to discover (-1 for all)
            sample_first: Extract only first N URLs for testing

        Returns:
            Complete extraction results
        """
        start_time = datetime.now()

        print("\n" + "="*80)
        print(f"🚀 FULL MERCHANT EXTRACTION PIPELINE")
        print("="*80)
        print(f"Merchant: {merchant_url}")
        print(f"Discovery method: {discovery_method}")
        print(f"Max products: {max_products if max_products > 0 else 'unlimited'}")
        print(f"Started at: {start_time.isoformat()}")
        print("="*80)

        # PHASE 1: Discover product URLs
        print("\n" + "="*80)
        print("📍 PHASE 1: PRODUCT URL DISCOVERY")
        print("="*80)

        discovery_result = await self.discovery_service.discover(
            merchant_url=merchant_url,
            method=discovery_method,
            max_urls=max_urls_discovery,
            max_depth=2,
            max_pages=100
        )

        print(f"\n✅ Discovery complete:")
        print(f"   - Total URLs: {discovery_result.total_urls}")
        print(f"   - Product URLs: {len(discovery_result.product_urls)}")
        print(f"   - Method: {discovery_result.discovery_method}")

        if not discovery_result.product_urls:
            print("\n❌ No product URLs found. Exiting.")
            return {
                "merchant_url": merchant_url,
                "discovery": discovery_result,
                "extraction": None,
                "error": "No product URLs discovered"
            }

        # Save discovery results
        discovery_file = self.discovery_service.save_results(discovery_result)

        # PHASE 2: Extract product data
        print("\n" + "="*80)
        print("📦 PHASE 2: PRODUCT DATA EXTRACTION")
        print("="*80)

        # Limit URLs if requested
        product_urls = discovery_result.product_urls

        if sample_first:
            print(f"🎲 Sampling first {sample_first} URLs for testing")
            product_urls = product_urls[:sample_first]

        if max_products > 0:
            product_urls = product_urls[:max_products]

        print(f"\n📋 Processing {len(product_urls)} product URLs...")

        # Extract products (with progress tracking)
        extraction_results = {}
        successful_extractions = 0
        failed_extractions = 0

        for i, url in enumerate(product_urls, 1):
            print(f"\n[{i}/{len(product_urls)}] Extracting from {url}")

            try:
                products = await self.extraction_pipeline.extract_products_from_url(url)

                if products:
                    extraction_results[url] = products
                    successful_extractions += 1
                    print(f"  ✅ Extracted {len(products)} product(s)")
                else:
                    extraction_results[url] = []
                    failed_extractions += 1
                    print(f"  ⚠️ No products extracted")

            except Exception as e:
                print(f"  ❌ Error: {e}")
                extraction_results[url] = []
                failed_extractions += 1

            # Progress update every 10 URLs
            if i % 10 == 0:
                print(f"\n📊 Progress: {i}/{len(product_urls)} URLs processed")
                print(f"   ✅ Successful: {successful_extractions}")
                print(f"   ❌ Failed: {failed_extractions}")

        # PHASE 3: Compile results
        print("\n" + "="*80)
        print("📊 PHASE 3: COMPILING RESULTS")
        print("="*80)

        end_time = datetime.now()
        duration = (end_time - start_time).total_seconds()

        # Flatten all products
        all_products = []
        for url, products in extraction_results.items():
            all_products.extend(products)

        final_results = {
            "merchant_url": merchant_url,
            "extraction_metadata": {
                "start_time": start_time.isoformat(),
                "end_time": end_time.isoformat(),
                "duration_seconds": duration,
                "discovery_method": discovery_result.discovery_method,
            },
            "discovery_summary": {
                "total_urls_discovered": discovery_result.total_urls,
                "product_urls_found": len(discovery_result.product_urls),
                "patterns_detected": discovery_result.url_patterns_detected,
                "discovery_file": str(discovery_file),
            },
            "extraction_summary": {
                "urls_processed": len(product_urls),
                "successful_extractions": successful_extractions,
                "failed_extractions": failed_extractions,
                "total_products_extracted": len(all_products),
                "success_rate": f"{(successful_extractions/len(product_urls)*100):.1f}%" if product_urls else "0%",
            },
            "extraction_results": extraction_results,
            "all_products": all_products,
        }

        # Save final results
        output_file = self._save_results(final_results, merchant_url)

        # Print summary
        print("\n" + "="*80)
        print("✅ EXTRACTION COMPLETE")
        print("="*80)
        print(f"Duration: {duration:.1f} seconds")
        print(f"\nDiscovery:")
        print(f"  - URLs discovered: {discovery_result.total_urls}")
        print(f"  - Product URLs: {len(discovery_result.product_urls)}")
        print(f"  - Method: {discovery_result.discovery_method}")
        print(f"\nExtraction:")
        print(f"  - URLs processed: {len(product_urls)}")
        print(f"  - Successful: {successful_extractions}")
        print(f"  - Failed: {failed_extractions}")
        print(f"  - Success rate: {(successful_extractions/len(product_urls)*100):.1f}%")
        print(f"  - Total products: {len(all_products)}")
        print(f"\nOutput:")
        print(f"  - Results saved to: {output_file}")
        print("="*80)

        return final_results

    def _save_results(self, results: Dict[str, Any], merchant_url: str) -> Path:
        """Save final results to file"""
        # Create filename from merchant URL
        from urllib.parse import urlparse
        domain = urlparse(merchant_url).netloc.replace(".", "_")
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        output_file = self.output_dir / f"merchant_{domain}_{timestamp}.json"

        with open(output_file, 'w', encoding='utf-8') as f:
            json.dump(results, f, indent=2, ensure_ascii=False)

        return output_file


async def main():
    """CLI interface"""
    parser = argparse.ArgumentParser(
        description="Discover and extract product data from merchant websites"
    )
    parser.add_argument(
        "--merchant",
        required=True,
        help="Merchant website URL (e.g., https://mercado.carrefour.com.br/)"
    )
    parser.add_argument(
        "--method",
        default="auto",
        choices=["auto", "url_seeding", "deep_crawl"],
        help="Discovery method (default: auto)"
    )
    parser.add_argument(
        "--max-products",
        type=int,
        default=-1,
        help="Maximum products to extract (-1 for all)"
    )
    parser.add_argument(
        "--max-discovery",
        type=int,
        default=-1,
        help="Maximum URLs to discover (-1 for all)"
    )
    parser.add_argument(
        "--sample",
        type=int,
        default=None,
        help="Extract only first N URLs for testing"
    )
    parser.add_argument(
        "--api-token",
        default="env:OPENAI_API_KEY",
        help="API token for LLM (default: env:OPENAI_API_KEY)"
    )

    args = parser.parse_args()

    # Run extraction
    async with FullMerchantExtractor(api_token=args.api_token) as extractor:
        await extractor.extract_merchant(
            merchant_url=args.merchant,
            discovery_method=args.method,
            max_products=args.max_products,
            max_urls_discovery=args.max_discovery,
            sample_first=args.sample
        )


if __name__ == "__main__":
    asyncio.run(main())
