#!/usr/bin/env node
/**
 * Helper script to suggest new representative historical points
 * for the Bitcoin Power Law demo.
 *
 * Usage:
 *   node scripts/update-historical-data.js
 *   node scripts/update-historical-data.js --from 2026-06-01
 *
 * It fetches recent daily BTC prices from CoinGecko (free, no key required)
 * and prints a ready-to-paste array snippet + the suggested new LATEST_DATE.
 *
 * Recommended: Run this quarterly or after big moves, then manually curate
 * 4–8 nice representative points from the output.
 */

const https = require('https');

const COINGECKO_API = 'https://api.coingecko.com/api/v3/coins/bitcoin/market_chart/range';

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const fromArg = args.find(a => a.startsWith('--from='))?.split('=')[1];

  // Default: last 18 months or so (adjust as needed)
  const now = Math.floor(Date.now() / 1000);
  const from = fromArg
    ? Math.floor(new Date(fromArg).getTime() / 1000)
    : Math.floor(Date.now() / 1000) - (18 * 30 * 24 * 3600);

  console.log('Fetching recent Bitcoin price data from CoinGecko...');
  console.log(`Range: ${new Date(from * 1000).toISOString().slice(0,10)} → now\n`);

  const url = `${COINGECKO_API}?vs_currency=usd&from=${from}&to=${now}`;
  let json;
  try {
    json = await fetchJson(url);
  } catch (e) {
    console.error('Failed to fetch data from CoinGecko.');
    console.error('You can still update the array manually from any price source.');
    process.exit(1);
  }

  const prices = json.prices || []; // [timestamp, price]
  if (prices.length === 0) {
    console.error('No price data returned.');
    process.exit(1);
  }

  // Group into approximate quarterly / notable points
  // (simple heuristic: take price near end of each month in the range)
  const pointsByMonth = new Map();

  for (const [ts, price] of prices) {
    const d = new Date(ts);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    // keep the last price of each month
    pointsByMonth.set(key, { date: d.toISOString().slice(0, 10), price: Math.round(price) });
  }

  const suggested = Array.from(pointsByMonth.values())
    .sort((a, b) => a.date.localeCompare(b.date));

  console.log('// Suggested new representative points to append:');
  console.log('const newPoints = [');
  for (const p of suggested) {
    console.log(`  { date: '${p.date}', price: ${p.price} },`);
  }
  console.log('];');
  console.log('');

  const lastPoint = suggested[suggested.length - 1];
  console.log(`// Suggested new LATEST_DATE_STR value:`);
  console.log(`// const LATEST_DATE_STR = '${lastPoint.date}';`);
  console.log('');

  console.log('Next steps:');
  console.log('1. Review the suggested points above.');
  console.log('2. Paste the ones you want into the historicalPoints array in index.html.');
  console.log('3. Update LATEST_DATE_STR if you added newer data.');
  console.log('4. Test the page (especially the time-range buttons and year-end table).');
  console.log('');
  console.log('Tip: You do not need to add every month — 4–8 well-chosen points per year is plenty.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
