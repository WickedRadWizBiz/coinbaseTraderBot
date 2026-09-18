const fs = require('fs');
let code = fs.readFileSync('src/components/PatternBrainView.tsx', 'utf8');

const interfaceTarget = `  tradeHistory: any[];
  invalidationReviews?: InvalidationReview[];
}`;
const interfaceNew = `  tradeHistory: any[];
  invalidationReviews?: InvalidationReview[];
  smartTrailingStats?: { [pattern: string]: { totalActivations: number, failures: number, totalEfficiencySum: number } };
}`;
code = code.replace(interfaceTarget, interfaceNew);

const tableHeadTarget = `<th className="text-right p-3 opacity-60 font-medium">Avg Win/Loss</th>
                  </tr>
                </thead>`;
const tableHeadNew = `<th className="text-right p-3 opacity-60 font-medium">Avg Win/Loss</th>
                    <th className="text-right p-3 opacity-60 font-medium whitespace-nowrap">Trail Efficiency</th>
                  </tr>
                </thead>`;
code = code.replace(tableHeadTarget, tableHeadNew);

const tableRowTarget = `<td className="text-right p-3">
                        <span className="text-crypto-success">+{winRec?.avgWinPnlPct?.toFixed(2) || '0.00'}%</span>
                        <span className="mx-2 opacity-30">/</span>
                        <span className="text-crypto-danger">{lossRec?.avgLossPnlPct?.toFixed(2) || '0.00'}%</span>
                      </td>
                    </tr>`;
const tableRowNew = `<td className="text-right p-3">
                        <span className="text-crypto-success">+{winRec?.avgWinPnlPct?.toFixed(2) || '0.00'}%</span>
                        <span className="mx-2 opacity-30">/</span>
                        <span className="text-crypto-danger">{lossRec?.avgLossPnlPct?.toFixed(2) || '0.00'}%</span>
                      </td>
                      <td className="text-right p-3">
                        {(() => {
                           const trailStat = data?.smartTrailingStats?.[p.key];
                           if (!trailStat || trailStat.totalActivations === 0) return <span className="opacity-30">-</span>;
                           const avgEff = trailStat.totalEfficiencySum / trailStat.totalActivations;
                           const failRate = trailStat.failures / trailStat.totalActivations;
                           const isFail = failRate > 0.1; // color red if high failures
                           return (
                             <div className="flex flex-col items-end">
                                <span className={avgEff >= 0.9 ? 'text-crypto-success' : 'text-crypto-secondary'}>
                                  {(avgEff * 100).toFixed(1)}% Capture
                                </span>
                                <span className={\`text-[10px] \${isFail ? 'text-crypto-danger' : 'text-crypto-primary/50'}\`}>
                                  {trailStat.failures}/{trailStat.totalActivations} Fails
                                </span>
                             </div>
                           );
                        })()}
                      </td>
                    </tr>`;
code = code.replace(tableRowTarget, tableRowNew);

fs.writeFileSync('src/components/PatternBrainView.tsx', code, 'utf8');
