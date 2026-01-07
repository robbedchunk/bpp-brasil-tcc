import { Injectable, Logger } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository, LessThan } from 'typeorm'
import { Store } from '../../database/entities/store.entity'
import { ScrapeJob } from '../scrape/entities/scrape-job.entity'
import { ScrapeLog } from '../scrape/entities/scrape-log.entity'
import { load } from 'cheerio'
import { UserAgentService } from '../../shared/user-agent.service'
import { UrlUtilsService } from '../../shared/url-utils.service'
import { ScrapeContent } from '../scrape/entities/scrape-content.entity'
import { ProxyUsage } from '../../database/entities/proxy-usage.entity'
import { Proxy } from '../../database/entities/proxy.entity'
import { ProxySelectionService } from '../proxy/proxy-selection.service'
import fetch, { RequestInit, Response } from 'node-fetch'
import { HttpsProxyAgent } from 'https-proxy-agent'

import { createHash } from 'crypto'

@Injectable()
export class WorkerService {
  private readonly logger = new Logger(WorkerService.name)

  constructor (
    @InjectRepository(Store)
    private readonly storeRepo: Repository<Store>,
    @InjectRepository(ScrapeJob)
    private readonly jobRepo: Repository<ScrapeJob>,
    @InjectRepository(ScrapeLog)
    private readonly logRepo: Repository<ScrapeLog>,
    private readonly userAgent: UserAgentService,
    private readonly urlUtils: UrlUtilsService,
    @InjectRepository(ScrapeContent)
    private readonly scrapeContentRepo: Repository<ScrapeContent>,
    @InjectRepository(Proxy)
    private readonly proxyRepo: Repository<Proxy>,
    @InjectRepository(ProxyUsage)
    private readonly proxyUsageRepo: Repository<ProxyUsage>,
    private readonly proxySelector: ProxySelectionService,
  ) {}

  async runAllStores () {
    const stores = await this.storeRepo.find({ where: { active: true } })
    this.logger.log(`Processing ${stores.length} stores...`)
    for (const store of stores) {
      await this.processPendingJobs(store)
    }
  }

  async processPendingJobs (store: Store) {
    const intervalHours =
      store.config?.intervalHours ??
      (store.config?.intervalMinutes
        ? store.config.intervalMinutes / 60
        : undefined) ??
      24

    const threshold = new Date(Date.now() - intervalHours * 3600 * 1000)

    const jobs = await this.jobRepo.find({
      where: [
        { status: 'pending', store: { id: store.id } },
        { lastScraped: LessThan(threshold), store: { id: store.id } },
      ],
      take: 20,
    })

    for (const job of jobs) {
      await this.processJob(job, store)
    }
  }

  async processJob (job: ScrapeJob, store: Store, depth = 0) {
    const start = performance.now()
    const proxy = await this.proxySelector.getRandomActiveProxy()
    const proxyAgent = this.buildProxyAgent(proxy)

    try {
      const headers = { 'User-Agent': this.userAgent.random() }
      const res = await fetch(job.url, { headers, agent: proxyAgent } as any)
      const html = await res.text()
      const $ = load(html)
      const latency = performance.now() - start
      await this.recordProxyUsage(proxy, true, latency, job, res)

      const hash = createHash('sha256').update(html).digest('hex')

      const last = await this.scrapeContentRepo.findOne({
        where: { scrapeJob: job },
        order: { scrapedAt: 'DESC' },
      })

      if (!last || last.contentHash !== hash) {
        try {
          await this.scrapeContentRepo.save({
            scrapeJob: job,
            html,
            contentHash: hash,
            statusCode: res.status,
            contentType: res.headers.get('content-type') ?? null,
          })
        } catch (error) {
          this.logger.error(
            `Error saving content snapshot for ${job.url}`,
            error,
          )
        }
        this.logger.log(`Saved new content snapshot for ${job.url}`)
      } else {
        this.logger.log(`No change for ${job.url}`)
      }

      // extract and store links
      const links = $('a[href]')
        .map((_, el) => $(el).attr('href'))
        .get()
        .map(href => this.urlUtils.normalizeUrl(href, store.baseUrl))
        .filter(
          (url): url is string => !!url && this.urlUtils.isValidUrl(url, store),
        )

      if (links.length === 0) {
        await this.jobRepo.update(job.id, {
          status: 'done',
          lastScraped: new Date(),
        })
        await this.logRepo.save({
          logLevel: 'info',
          message: `Scraped ${job.url} → no links`,
        })
        return
      }
      if (!links) {
        await this.jobRepo.update(job.id, { status: 'error' })
        await this.logRepo.save({
          logLevel: 'error',
          message: `Error scraping ${job.url}: no links found`,
        })
        return
      }
      if (links && links.length > 0)
        await this.enqueueNewLinks(links, store, depth)

      await this.jobRepo.update(job.id, {
        status: 'done',
        lastScraped: new Date(),
      })
      await this.logRepo.save({
        logLevel: 'info',
        message: `Scraped ${job.url} → ${links.length} links`,
      })
    } catch (e) {
      const latency = performance.now() - start
      await this.jobRepo.update(job.id, { status: 'error' })
      await this.logRepo.save({
        logLevel: 'error',
        message: `Error scraping ${job.url}: ${e.message}`,
      })
      await this.recordProxyUsage(proxy, false, latency, job)
    }
  }

  private async enqueueNewLinks (
    links: string[],
    store: Store,
    depth: number,
  ): Promise<void> {
    if (depth >= (store.config?.maxDepth ?? 20)) return
    for (const url of links) {
      const normalizedLink = this.urlUtils.normalizeUrl(url, store.baseUrl)
      if (!normalizedLink) continue // ← skip null/empty

      // exists check
      const exists = await this.jobRepo.exists({
        where: { url: normalizedLink },
      })
      if (!exists) {
        const job = this.jobRepo.create({
          url: normalizedLink, // now guaranteed string
          status: 'pending',
          store,
        })
        await this.jobRepo.save(job)
      }
    }
  }

  buildProxyAgent (proxy: Proxy | null): HttpsProxyAgent<string> | undefined {
    if (!proxy || !proxy.ip || !proxy.port) return undefined

    const auth = proxy.username ? `${proxy.username}:${proxy.pass}@` : ''
    const proxyUrl = `http://${auth}${proxy.ip}:${proxy.port}`
    return new HttpsProxyAgent(proxyUrl)
  }

  async recordProxyUsage (
    proxy: Proxy | null,
    ok: boolean,
    latency: number,
    job: ScrapeJob,
    res?: Response,
  ): Promise<void> {
    if (!proxy) return
    await this.proxyRepo.increment({ id: proxy.id }, 'totalRequests', 1)
    await this.proxyRepo.increment(
      { id: proxy.id },
      ok ? 'successCount' : 'failureCount',
      1,
    )
    await this.proxyRepo.update(proxy.id, {
      last_status: ok ? 'success' : 'fail',
      last_used: new Date(),
    })
    await this.proxyUsageRepo.save({
      proxy,
      scrapeJob: job,
      status: ok ? 'success' : 'fail',
      responseCode: res?.status ?? null,
      latencyMs: latency ? Math.round(latency) : null,
      url: job.url,
    })
  }

  async processStore (store: Store) {
    const url = store.baseUrl || store.domain
    this.logger.log(`Scraping store: ${store.name} (${url})`)

    if (!url) {
      this.logger.warn(`Skipping ${store.name} – no baseUrl or domain`)
      return
    }

    try {
      const ua = this.userAgent.random()

      const res = await fetch(url, {
        headers: { 'User-Agent': ua },
      })
      const html = await res.text()
      const $ = load(html)
      const links = new Set<string>()

      $('a[href]').each((_, el) => {
        const href = $(el).attr('href')
        if (href && href.startsWith('http')) links.add(href)
      })

      const discovered = Array.from(links).slice(0, 100) // limit to 100 for demo
      this.logger.log(`Found ${discovered.length} links at ${url}`)

      // Insert discovered links as scrape jobs
      for (const link of discovered) {
        if (!this.urlUtils.isValidUrl(link, store)) {
          this.logger.warn(`Skipping invalid link: ${link}`)
          continue
        }

        const normalizedLink = this.urlUtils.normalizeUrl(link, store.baseUrl)

        const existing = await this.jobRepo.findOne({
          where: { url: link },
        })
        if (!existing) {
          const job = this.jobRepo.create({
            url: link,
            store,
            status: 'pending',
          })
          await this.jobRepo.save(job)
        }
      }

      await this.logRepo.save({
        logLevel: 'info',
        message: `Processed ${store.name}, found ${discovered.length} links.`,
      })
    } catch (err: any) {
      this.logger.error(`Error scraping ${store.name}: ${err.message}`)
      await this.logRepo.save({
        logLevel: 'error',
        message: `Error scraping ${store.name}: ${err.message}`,
      })
    }
  }
}
