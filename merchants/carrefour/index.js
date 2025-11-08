// carrefour_dump_all.mjs  | Node 18+
// Saída: carrefour_products.ndjson
import fs from 'fs'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const BASE = "https://mercado.carrefour.com.br";
const OUT = "carrefour_products.ndjson";
const PAGE = 50;                   // VTEX: máx 50 por janela
const MAX_FROM = 2500;             // limite VTEX
const HEADERS = { "accept": "application/json", "user-agent": "Mozilla/5.0" };

const setProduct = new Set();
const out = fs.createWriteStream(OUT, { flags: "w" });

async function j(url, attempt = 1) {
  try {
    const r = await fetch(url, { headers: HEADERS });
    if (r.status === 429 || r.status >= 500) {
      const wait = Math.min(30000, 500 * 2 ** (attempt - 1));
      await sleep(wait);
      if (attempt < 6) return j(url, attempt + 1);
    }
    if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
    return r.json();
  } catch (e) {
    if (attempt < 6) {
      const wait = Math.min(30000, 500 * 2 ** (attempt - 1));
      await sleep(wait);
      return j(url, attempt + 1);
    }
    throw e;
  }
}

async function listBrands() {
  // /api/catalog_system/pub/brand/list (ou per-page)
  const url = `${BASE}/api/catalog_system/pub/brand/list`;
  return j(url); // [{id, name, ...}]
}

async function listCategories(level = 3) {
  // /api/catalog_system/pub/category/tree/{level}
  const url = `${BASE}/api/catalog_system/pub/category/tree/${level}`;
  return j(url); // árvore com ids
}

async function dumpShard(params) {
  // params: { fq: "B:ID" } ou { fq: "C:/dep/cat/sub" } etc.
  let from = 0, got = 0;
  while (from <= MAX_FROM) {
    const to = from + PAGE - 1;
    const url = `${BASE}/api/catalog_system/pub/products/search/?ft=&_from=${from}&_to=${to}` +
                (params?.fq ? `&fq=${encodeURIComponent(params.fq)}` : "");
    const arr = await j(url);
    if (!Array.isArray(arr) || arr.length === 0) break;

    for (const p of arr) {
      const id = p?.productId;
      if (!id || setProduct.has(id)) continue;
      setProduct.add(id);
      out.write(JSON.stringify(p) + "\n");
      got++;
    }

    if (arr.length < PAGE) break;     // último bloco
    from += PAGE;
    await sleep(150);
  }
  return got;
}

function flattenCats(nodes, prefix = []) {
  const list = [];
  for (const n of nodes || []) {
    const path = [...prefix, n.id];
    list.push({ id: n.id, fq: `C:/${path.join("/")}` });
    if (n.children && n.children.length) list.push(...flattenCats(n.children, path));
  }
  return list;
}

async function main() {
  let total = 0;

  // 1) Shard por MARCA
  const brands = await listBrands(); // pode retornar milhares
  for (const b of brands || []) {
    total += await dumpShard({ fq: `B:${b.id}` });
  }

  // 2) Passo complementar por CATEGORIA para cobrir itens sem marca
  const catTree = await listCategories(3);
  const cats = flattenCats(catTree);
  for (const c of cats) {
    total += await dumpShard({ fq: c.fq });
  }

  out.end();
  console.log(`Produtos únicos: ${setProduct.size}. Linhas gravadas: ${total}. Arquivo: ${OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
