// Reads a pasted shopping link: tidies it (drops tracking junk) and, when the address
// contains a product name, turns it into a title. Most stores put the name in the path:
//   amazon.com/Razer-Basilisk-V3-Pro/dp/B0B6…      walmart.com/ip/Some-Product-Name/123
//   target.com/p/some-product-name/-/A-123         bestbuy.com/site/product-name/6447382.p
//   etsy.com/listing/123/handmade-leather-wallet   shop.com/products/doughy-grips-overgrip
// The page itself can't be read from the browser (stores block that), so when no part of
// the address looks like a name, there's no title and the field is left for the person.

const TRACKING = /^(utm_|ref|ref_|crid|dib|dib_tag|sprefix|qid|sr|th|psc|keywords|fbclid|gclid|gbraid|wbraid|msclkid|srsltid|_encoding|pd_rd_|pf_rd_|content-id|hsa_|adgrpid|hvadid|hvcampaign|hvdev|hvexpln|hvlocphy|hvnetw|hvocijid|hvqmt|hvrand|hvtargid|hydadcr|mcid|aref|sp_csd|irclickid|irgwc|clickid|cmpid|campaignid|ranmid|ranEAID|ranSiteID|tag|linkCode|ascsubtag|smid|spm|scm|_trkparms|_trksid|mkcid|mkevt|mkrid|from|fromShop|abcid|ld|lsft|cjevent)/i;
const STOP = new Set(['dp', 'gp', 'aw', 'd', 'ip', 'p', 'pd', 'prd', 'site', 'shop', 'product', 'products',
  'item', 'itm', 'listing', 'listings', 'buy', 'store', 'stores', 'en', 'us', 'en-us', 'www', 'collections',
  'collection', 'catalog', 't', 's', 'ref', 'index', 'html', 'detail', 'details', 'pdp', 'sku', 'b', 'c']);
const SMALL = new Set(['a', 'an', 'and', 'or', 'of', 'for', 'with', 'the', 'to', 'in', 'on', 'by']);

export const asinOf = (url) => (String(url).match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i) || [])[1];

function safeDecode(s) { try { return decodeURIComponent(s); } catch { return s; } }

function titleFromPath(pathname) {
  let best = null;
  for (const raw of pathname.split('/').filter(Boolean)) {
    const seg = safeDecode(raw)
      .replace(/\.product\.\d+\.html$/i, '')
      .replace(/\.(html?|jsp|aspx?|php|p|htm)$/i, '');
    const words = seg.split(/[-_+\s]+/).filter(Boolean).filter((w) => {
      if (/^\d{4,}$/.test(w)) return false;                       // long numbers: product ids
      if (/\d/.test(w) && w.length >= 6 && /[a-z]/i.test(w)) return false; // B0B6Y3XYFG, N82E1682
      return true;
    });
    const real = words.filter((w) => /[a-z]/i.test(w) && !STOP.has(w.toLowerCase()));
    if (real.length < 2) continue;
    if (!best || real.length > best.score) best = { words, score: real.length };
  }
  if (!best) return '';
  const title = best.words
    .filter((w, i, all) => !(STOP.has(w.toLowerCase()) && (i === 0 || i === all.length - 1)))
    .map((w, i) => {
      if (w !== w.toLowerCase()) return w;                       // keep "MX", "iPhone", "V3"
      if (i > 0 && SMALL.has(w)) return w;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(' ');
  if (title.length <= 80) return title;
  return title.slice(0, 80).replace(/\s+\S*$/, '');
}

export function readLink(raw) {
  const t = String(raw || '').trim();
  if (!t) return null;
  let url;
  try { url = new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`); } catch { return null; }
  if (!url.hostname.includes('.')) return null;
  const store = url.hostname.replace(/^(www|m|smile)\./, '');
  const isAmazon = /(^|\.)amazon\./i.test(url.hostname);
  const asin = asinOf(url.href);

  let clean;
  if (isAmazon && asin) {
    clean = `https://www.amazon.com/dp/${asin}`;
  } else {
    const keep = new URLSearchParams();
    for (const [k, v] of url.searchParams) if (!TRACKING.test(k)) keep.set(k, v);
    const q = keep.toString();
    clean = `${url.origin}${url.pathname}${q ? `?${q}` : ''}`;
  }
  return { url: clean, title: titleFromPath(url.pathname), store };
}
