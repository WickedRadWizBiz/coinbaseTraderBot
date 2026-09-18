const fs = require('fs');
let content = fs.readFileSync('src/components/DashboardView.tsx', 'utf-8');

// Add market context state
content = content.replace(
  'const [loading, setLoading] = useState(true);',
  'const [loading, setLoading] = useState(true);\n  const [marketContext, setMarketContext] = useState<any>(null);'
);

// Add fetch call for market context
content = content.replace(
  "fetch('/api/candles/BTC-15M-UP')",
  "fetch('/api/candles/BTC-15M-UP'),\n        fetch('/api/market-context')"
);

content = content.replace(
  "const chart = await chartRes.json();",
  "const chart = await chartRes.json();\n      const context = await balRes /* this is tricky, wait let's use exact match */"
);

