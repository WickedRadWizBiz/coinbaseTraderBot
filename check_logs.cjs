const http = require('http');

http.get('http://localhost:3000/api/v1/train-model/status', (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    const json = JSON.parse(data);
    if (json.report && json.report.logMessages) {
       console.log("LATEST REPORT LOGS:");
       console.log(json.report.logMessages.join('\n'));
    } else {
       console.log("No report found");
    }
  });
});
