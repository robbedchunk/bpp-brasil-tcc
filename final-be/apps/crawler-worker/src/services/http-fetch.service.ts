import { Injectable, Logger } from '@nestjs/common';
import { HttpFetchRepository, CreateHttpFetchData } from '@app/database';
import { IHttpFetchService, FetchOptions, FetchResponse } from '@app/common';
import { createHash } from 'crypto';

/**
 * HTTP Fetch service that records all fetches to the database.
 * Implements the IHttpFetchService interface used by crawlers.
 */
@Injectable()
export class HttpFetchService implements IHttpFetchService {
  private readonly logger = new Logger(HttpFetchService.name);

  constructor(private readonly httpFetchRepo: HttpFetchRepository) {}

  /**
   * Fetch a URL and record the request/response to the database
   */
  async fetch(
    runId: bigint,
    url: string,
    options: FetchOptions = {},
  ): Promise<FetchResponse> {
    const startTime = Date.now();

    const {
      method = 'GET',
      headers = {},
      body,
      timeout = 30000,
      followRedirects = true,
    } = options;

    // Default headers
    const defaultHeaders: Record<string, string> = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
      'Cache-Control': 'no-cache',
      ...headers,
    };

    let response: Response | undefined;
    let responseBody = '';
    let errorClass: string | undefined;
    let errorMessage: string | undefined;
    let isBlocked = false;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      response = await fetch(url, {
        method,
        headers: defaultHeaders,
        body,
        signal: controller.signal,
        redirect: followRedirects ? 'follow' : 'manual',
      });

      clearTimeout(timeoutId);

      responseBody = await response.text();

      // Check for common blocking patterns
      isBlocked = this.detectBlocking(response, responseBody);

      if (isBlocked) {
        errorClass = 'blocked';
        errorMessage = 'Request appears to be blocked by bot detection';
      }
    } catch (error) {
      const err = error as Error;

      if (err.name === 'AbortError') {
        errorClass = 'timeout';
        errorMessage = `Request timed out after ${timeout}ms`;
      } else {
        errorClass = 'network';
        errorMessage = err.message;
      }

      this.logger.warn(`Fetch error for ${url}: ${errorMessage}`);
    }

    const durationMs = Date.now() - startTime;
    const bodySha256 = responseBody
      ? createHash('sha256').update(responseBody).digest()
      : undefined;

    // Record the fetch to the database
    const fetchData: CreateHttpFetchData = {
      runId,
      url,
      finalUrl: response?.url || url,
      httpStatus: response?.status,
      contentType: response?.headers.get('content-type') || undefined,
      durationMs,
      responseHeaders: response
        ? Object.fromEntries(response.headers.entries())
        : undefined,
      bodySha256,
      bodyBytes: responseBody ? BigInt(Buffer.byteLength(responseBody)) : undefined,
      errorClass,
      errorMessage,
      isBlocked,
      // Note: bodyStorageKey would be set if we're storing bodies in S3/GCS
      // For now, we don't store the body externally
    };

    const dbFetch = await this.httpFetchRepo.createFetch(fetchData);

    return {
      fetchId: dbFetch.fetchId,
      url,
      finalUrl: response?.url || url,
      httpStatus: response?.status || 0,
      contentType: response?.headers.get('content-type') || '',
      body: responseBody,
      bodySha256,
      durationMs,
      isBlocked,
    };
  }

  /**
   * Detect common blocking patterns in the response
   */
  private detectBlocking(response: Response, body: string): boolean {
    // Check status codes often used for blocking
    if ([403, 429, 503].includes(response.status)) {
      return true;
    }

    // Check for common CAPTCHA/blocking indicators in body
    const blockingPatterns = [
      /captcha/i,
      /robot/i,
      /blocked/i,
      /access denied/i,
      /rate limit/i,
      /too many requests/i,
      /cloudflare/i,
      /incapsula/i,
      /distil/i,
      /datadome/i,
      /perimeterx/i,
    ];

    for (const pattern of blockingPatterns) {
      if (pattern.test(body)) {
        return true;
      }
    }

    return false;
  }
}
