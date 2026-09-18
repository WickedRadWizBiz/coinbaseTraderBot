const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const page = await browser.newPage();
  
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', err => console.log('PAGE ERROR:', err.message));
  
  // Set viewport to a desktop size
  await page.setViewport({ width: 1280, height: 800 });

  await page.goto('http://localhost:3000', { waitUntil: 'networkidle0' });
  
  // Try to find the root element
  const rootContent = await page.$eval('#root', el => el.innerHTML);
  console.log('ROOT HTML:', rootContent.substring(0, 500));
  
  await browser.close();
})();
