const fs = require('fs');
let code = fs.readFileSync('src/components/DashboardView.tsx', 'utf8');

const interfaceTarget = `  session_info?: SessionInfo;`;
const interfaceNew = `  session_info?: SessionInfo;
  macroGoalGrade?: number;
  macroCycleProfit?: number;`;
code = code.replace(interfaceTarget, interfaceNew);

const hudTarget = `<div className="flex flex-col">
            <span className="text-[10px] text-crypto-primary/60 uppercase tracking-widest mb-1">Total Equity</span>
            <span className="text-xl font-bold font-mono tracking-tight text-crypto-primary">`;

const actualNewHud = "<div className=\"flex flex-col\">\n            <span className=\"text-[10px] text-crypto-primary/60 uppercase tracking-widest mb-1 flex items-center justify-between\">\n               <span>Total Equity</span>\n               {balance?.macroGoalGrade !== undefined && (\n                 <span className=\"text-crypto-secondary opacity-80 border border-crypto-secondary/30 px-1.5 py-0.5 rounded-sm\">\n                   MACRO GOAL: ${(balance?.macroCycleProfit || 0).toFixed(2)} / $100 ({(balance.macroGoalGrade * 100).toFixed(0)}% PACE)\n                   {balance.macroGoalGrade >= 1.0 && ' ★'}\n                 </span>\n               )}\n            </span>\n            <span className=\"text-xl font-bold font-mono tracking-tight text-crypto-primary\">";

code = code.replace(hudTarget, actualNewHud);

fs.writeFileSync('src/components/DashboardView.tsx', code, 'utf8');
console.log('Patched dashboard');
