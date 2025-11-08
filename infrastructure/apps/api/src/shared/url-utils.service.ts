import { Injectable } from '@nestjs/common'
import { Store } from '../database/entities/store.entity'

@Injectable()
export class UrlUtilsService {
  /**
   * Safely normalize a URL or relative path.
   */
  normalizeUrl (href?: string | null, base?: string | null): string | null {
    if (!href) return null
    try {
      const resolved = new URL(href, base || undefined)
      return resolved.toString()
    } catch {
      return null
    }
  }

  /**
   * Checks if a URL is valid and belongs to an allowed domain.
   */
  isValidUrl (url?: string | null, store?: Store | null): boolean {
    if (!url || !store) return false
    try {
      const u = new URL(url)
      const allowedDomains =
        store.config?.allowedDomains ??
        [store.domain, store.baseUrl].filter(Boolean)
      return allowedDomains.some(domain =>
        domain ? u.hostname.includes(domain.replace(/^https?:\/\//, '')) : false
      )
    } catch {
      return false
    }
  }
}
