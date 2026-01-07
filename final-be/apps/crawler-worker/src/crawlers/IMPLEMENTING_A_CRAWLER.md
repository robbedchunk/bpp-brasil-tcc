# Implementing a Category Crawler

You need to implement 3 methods. That's it.

## The 3 Methods

```typescript
interface ICatalogCrawler {
  discoverCategories(context): Promise<CategoryDiscoveryResult>;
  crawlCategoryPage(context, categoryUrl): Promise<CategoryCrawlResult>;
  fetchProduct(context, productUrl): Promise<ProductFetchResult>;
}
```

1. **discoverCategories** - Hit the site's homepage/sitemap, return a list of top-level categories
2. **crawlCategoryPage** - Given a category URL, return products found + pagination + subcategories
3. **fetchProduct** - Given a product URL, parse and return product data

## Quick Start

1. Create your crawler file: `crawlers/your-site/your-site.crawler.ts`
2. Extend `BaseCatalogCrawler`
3. Register it in `registry/crawler.registry.ts`

## Minimal Example

```typescript
import { BaseCatalogCrawler } from '../base/base-crawler';
import {
  CrawlerContext,
  CategoryDiscoveryResult,
  CategoryCrawlResult,
  ProductFetchResult,
  DiscoveredCategory,
  DiscoveredProduct,
} from '@app/common';

export class ExampleCrawler extends BaseCatalogCrawler {
  readonly crawlerId = 'example-store';
  readonly displayName = 'Example Store';
  readonly supportedMerchantIds = [BigInt(1)]; // your merchant ID from DB

  async discoverCategories(context: CrawlerContext): Promise<CategoryDiscoveryResult> {
    const categories: DiscoveredCategory[] = [];
    const errors: CrawlError[] = [];

    const response = await context.httpFetchService.fetch(
      context.runId,
      context.websiteBaseUrl,
    );

    if (response.isBlocked) {
      errors.push(this.createError('blocked', 'Homepage blocked'));
      return { categories, errors };
    }

    // Parse your categories from response.body (HTML)
    // Example: find all <a> tags with class "nav-category"
    const matches = response.body.matchAll(/<a[^>]*class="nav-category"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/gi);

    for (const match of matches) {
      categories.push({
        url: this.normalizeUrl(match[1], context.websiteBaseUrl),
        name: this.cleanText(match[2]) || 'Unknown',
        breadcrumb: [this.cleanText(match[2]) || 'Unknown'],
        hasSubcategories: false,
      });
    }

    return { categories, errors };
  }

  async crawlCategoryPage(context: CrawlerContext, categoryUrl: string): Promise<CategoryCrawlResult> {
    const products: DiscoveredProduct[] = [];
    const subcategoryUrls: string[] = [];
    const errors: CrawlError[] = [];
    let nextPageUrl: string | undefined;

    const response = await context.httpFetchService.fetch(context.runId, categoryUrl);

    if (response.isBlocked) {
      errors.push(this.createError('blocked', 'Category blocked', categoryUrl));
      return { categoryUrl, products, subcategoryUrls, errors };
    }

    // Extract product URLs
    const productMatches = response.body.matchAll(/data-product-url="([^"]+)"/gi);
    for (const match of productMatches) {
      products.push({
        url: this.normalizeUrl(match[1], context.websiteBaseUrl),
      });
    }

    // Check pagination - return nextPageUrl and the orchestrator handles the rest
    const nextMatch = response.body.match(/<a[^>]*class="next-page"[^>]*href="([^"]+)"/);
    if (nextMatch) {
      nextPageUrl = this.normalizeUrl(nextMatch[1], context.websiteBaseUrl);
    }

    return { categoryUrl, products, subcategoryUrls, nextPageUrl, errors };
  }

  async fetchProduct(context: CrawlerContext, productUrl: string): Promise<ProductFetchResult> {
    const response = await context.httpFetchService.fetch(context.runId, productUrl);

    if (response.isBlocked) {
      return {
        productUrl,
        fetchId: response.fetchId,
        success: false,
        error: this.createError('blocked', 'Product blocked', productUrl),
      };
    }

    // Try JSON-LD first (most sites have this)
    const jsonLd = this.extractJsonLd(response.body);

    if (jsonLd && jsonLd.name) {
      return {
        productUrl,
        fetchId: response.fetchId,
        success: true,
        product: {
          name: jsonLd.name,
          gtin: jsonLd.gtin,
          brand: jsonLd.brand?.name,
          description: jsonLd.description,
          categoryBreadcrumb: [],
          imageUrls: Array.isArray(jsonLd.image) ? jsonLd.image : [jsonLd.image].filter(Boolean),
          attributes: {},
          rawProductJson: jsonLd,
        },
      };
    }

    // Fallback: parse HTML manually
    const name = this.extractFromHtml(response.body, /<h1[^>]*class="product-title"[^>]*>([^<]+)<\/h1>/);

    return {
      productUrl,
      fetchId: response.fetchId,
      success: true,
      product: {
        name: this.cleanText(name) || 'Unknown',
        categoryBreadcrumb: [],
        imageUrls: [],
        attributes: {},
      },
    };
  }
}
```

## Register Your Crawler

In `registry/crawler.registry.ts`:

```typescript
import { ExampleCrawler } from '../example/example.crawler';

@Injectable()
export class CrawlerRegistry implements OnModuleInit {
  async onModuleInit() {
    this.registerCrawler(new ExampleCrawler());
  }
}
```

## Base Class Utilities

`BaseCatalogCrawler` gives you these helpers:

| Method | What it does |
|--------|-------------|
| `normalizeUrl(url, base)` | Converts relative URLs to absolute |
| `extractJsonLd(html)` | Extracts JSON-LD Product data from HTML |
| `extractFromHtml(html, regex, group)` | Extract text with regex |
| `cleanText(str)` | Trim + normalize whitespace |
| `parsePrice(str)` | Parse "R$ 1.234,56" → 1234.56 |
| `createError(type, msg, url?)` | Create a structured CrawlError |
| `withRetry(fn, attempts, delay)` | Retry with exponential backoff |

## Key Types

**DiscoveredCategory** - what you return from `discoverCategories`:
```typescript
{
  url: string;           // category page URL
  name: string;          // display name
  breadcrumb: string[];  // hierarchy path
  hasSubcategories: boolean;
  parentUrl?: string;
  productCount?: number;
}
```

**DiscoveredProduct** - what you return from `crawlCategoryPage`:
```typescript
{
  url: string;              // product page URL (required)
  sourceProductId?: string; // merchant's internal ID
  gtin?: string;            // barcode if visible
  name?: string;            // product name if visible
  thumbnailUrl?: string;    // thumbnail if visible
}
```

**ParsedProduct** - what you return from `fetchProduct`:
```typescript
{
  name: string;                        // required
  gtin?: string;
  brand?: string;
  description?: string;
  categoryBreadcrumb: string[];
  packageSizeText?: string;
  imageUrls: string[];
  attributes: Record<string, unknown>; // custom data
  rawProductJson?: Record<string, unknown>;
}
```

## How the System Works

You don't manage pagination or recursion. The processor does:

1. Calls your `discoverCategories()` → gets category list
2. For each category, calls `crawlCategoryPage()`
3. If you return `nextPageUrl`, it queues another crawl for that page
4. If you return `subcategoryUrls`, it queues crawls for those too
5. For each product found, it queues a `fetchProduct()` call

All HTTP requests are automatically recorded to the database via `httpFetchService`.

## Tips

**Always check `isBlocked`** - the HTTP service detects bot blocking (Cloudflare, DataDome, etc.)

**Use JSON-LD when available** - most modern ecommerce sites embed structured data:
```typescript
const jsonLd = this.extractJsonLd(response.body);
if (jsonLd?.['@type'] === 'Product') {
  // use jsonLd.name, jsonLd.gtin, jsonLd.offers, etc.
}
```

**Don't throw errors** - collect them in the errors array and return partial results:
```typescript
try {
  // parse something
} catch (e) {
  errors.push(this.createError('parse', e.message, url));
}
return { products, errors }; // still return what you got
```

**Test with a single category first** - use the context params to limit scope during development.

## File Locations

- Interfaces: `libs/common/src/interfaces/crawler.interface.ts`
- Base class: `apps/crawler-worker/src/crawlers/base/base-crawler.ts`
- Registry: `apps/crawler-worker/src/crawlers/registry/crawler.registry.ts`
- Processor: `apps/crawler-worker/src/processors/category-crawl.processor.ts`
