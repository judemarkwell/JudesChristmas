// Link reader tests: node tests/links.test.mjs
import assert from 'node:assert/strict';
import { readLink } from '../js/links.js';

const cases = [
  ['https://www.amazon.com/Razer-Basilisk-Customizable-Wireless-Gaming/dp/B0B6Y3XYFG/ref=sr_1_3?crid=1&th=1',
    'Razer Basilisk Customizable Wireless Gaming', 'https://www.amazon.com/dp/B0B6Y3XYFG'],
  ['https://www.amazon.com/gp/aw/d/B0FWR75LMG?pd_rd_plhdr=t', '', 'https://www.amazon.com/dp/B0FWR75LMG'],
  ['https://www.walmart.com/ip/Logitech-G305-LIGHTSPEED-Wireless-Gaming-Mouse/567425463', 'Logitech G305 LIGHTSPEED Wireless Gaming Mouse'],
  ['https://www.bestbuy.com/site/apple-airpods-pro-2nd-generation/6447382.p?skuId=6447382', 'Apple Airpods Pro 2nd Generation'],
  ['https://www.etsy.com/listing/1234567890/personalized-leather-wallet-mens-gift', 'Personalized Leather Wallet Mens Gift'],
  ['https://shop.com/products/doughy-grips-soft-and-tacky-pickleball-overgrip?fromShop=true&variantId=45',
    'Doughy Grips Soft and Tacky Pickleball Overgrip', 'https://shop.com/products/doughy-grips-soft-and-tacky-pickleball-overgrip?variantId=45'],
  ['https://www.homedepot.com/p/DEWALT-20V-MAX-Cordless-Drill-Driver-Kit-DCD771C2/204279858', 'DEWALT 20V MAX Cordless Drill Driver Kit'],
  ['https://www.costco.com/kirkland-signature-mens-performance-polo.product.4000123456.html', 'Kirkland Signature Mens Performance Polo'],
  ['https://a.co/d/abc1234', ''],
  ['https://www.newegg.com/p/N82E16826104123', ''],
];
for (const [input, title, url] of cases) {
  const r = readLink(input);
  assert.equal(r.title, title, input);
  if (url) assert.equal(r.url, url, input);
}
assert.equal(readLink('not a link'), null);
console.log(`${cases.length + 1} link tests passed`);
