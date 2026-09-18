const fs = require('fs');

try {
  const data = JSON.parse(fs.readFileSync('bot_memory_db.json', 'utf8'));
  console.log("Keys:", Object.keys(data));
  if (Array.isArray(data)) {
      console.log("Root is array of size:", data.length);
  }
} catch (e) {
  console.error(e);
}
