const fs = require('fs');
let code = fs.readFileSync('metaLearningEngine.ts', 'utf8');

code = code.replace(/this\.latestReport = report;/g, "this.latestReports.set(strategyKey, report);");
code = code.replace(/this\.reportHistory\.unshift\(report\);/g, "const hist = this.reportHistories.get(strategyKey) || []; hist.unshift(report); this.reportHistories.set(strategyKey, hist);");
code = code.replace(/if \(this\.reportHistory\.length > 50\) this\.reportHistory = this\.reportHistory\.slice\(0, 50\);/g, "if (hist.length > 50) this.reportHistories.set(strategyKey, hist.slice(0, 50));");

code = code.replace(/this\.latestReport = failedReport;/g, "this.latestReports.set(strategyKey, failedReport);");
code = code.replace(/this\.reportHistory\.unshift\(failedReport\);/g, "const fHist = this.reportHistories.get(strategyKey) || []; fHist.unshift(failedReport); this.reportHistories.set(strategyKey, fHist);");
code = code.replace(/if \(this\.reportHistory\.length > 50\) this\.reportHistory = this\.reportHistory\.slice\(0, 50\);/g, "if (fHist.length > 50) this.reportHistories.set(strategyKey, fHist.slice(0, 50));");

fs.writeFileSync('metaLearningEngine.ts', code, 'utf8');
console.log('Updated end of pipeline');
