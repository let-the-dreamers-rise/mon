import { chromium } from 'playwright';
const out = process.argv[2];
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? undefined });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
for (const id of ['title', 'footage', 'monad', 'security', 'watchers', 'end']) {
  await page.goto(`file://${new URL('./slides.html', import.meta.url).pathname}#${id}`);
  await page.reload();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/slide-${id}.png`, omitBackground: true });
}
await browser.close();
console.log('ok');
