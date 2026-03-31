import { spawnSync } from 'child_process';
import fs from 'fs';

const intervals = ['5m', '15m', '1h'];
let finalOutput = '';

for (const interval of intervals) {
    console.log(`Running interval ${interval}...`);
    finalOutput += `\n#####################################################\n`;
    finalOutput += `### RESULTS FOR INTERVAL: ${interval.padEnd(4, ' ')}                    ###\n`;
    finalOutput += `#####################################################\n`;
    
    const result = spawnSync('node', ['backtest.js', '--interval', interval], { encoding: 'utf8' });
    
    if (result.stdout) {
        // Extract the table from the end
        const tableStart = result.stdout.lastIndexOf('┌──');
        if (tableStart !== -1) {
            const tableStr = result.stdout.slice(tableStart);
            finalOutput += tableStr.replace(/========================================================\nExit code: 0\n?$/, '');
        } else {
            finalOutput += "Table not found... Output:\n" + result.stdout.slice(-1000);
        }
    }
}

fs.writeFileSync('all_intervals_results.txt', finalOutput);
console.log("Done! Wrote to all_intervals_results.txt");
