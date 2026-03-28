import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import url from 'url';
import dotenv from 'dotenv';
import { STRATEGIES, TOKENS, SOL_RESERVE } from './sol_usdc_trading_bot.js';
import { ProfitGuardedStrategy } from './strategies/ProfitGuardedStrategy.js';
import { VolumeBreakoutStrategy } from './strategies/VolumeBreakoutStrategy.js';
import { GridScalperStrategy } from './strategies/GridScalperStrategy.js';

dotenv.config();

async function runBacktest() {
    // Smart Argument Parsing
    let initialAsset = 'SOL';
    let initialAmount = 60;
    let targetInterval = '1m';

    const arg1 = process.argv[2];
    const arg2 = process.argv[3];
    const arg3 = process.argv[4]; // Optional interval parameter

    if (arg1) {
        if (!isNaN(parseFloat(arg1))) {
            initialAmount = parseFloat(arg1);
            if (arg2) initialAsset = arg2.toUpperCase();
            if (arg3) targetInterval = arg3;
        } else {
            initialAsset = arg1.toUpperCase();
            if (arg2 && !isNaN(parseFloat(arg2))) initialAmount = parseFloat(arg2);
            if (arg3) targetInterval = arg3;
        }
    }

    const HIST_DIR = `./historical_data/${targetInterval}`;

    console.log(`\n========================================================`);
    console.log(`   SOL-USDC BACKTESTING ENGINE - ALL STRATEGIES`);
    console.log(`   Interval: ${targetInterval} | Initial Balance: ${initialAmount} ${initialAsset}`);
    console.log(`   Target Directory: ${HIST_DIR}`);
    console.log(`========================================================\n`);

    // 1. Scan for CSV files in historical_data/
    let allFiles = [];
    try {
        const histFiles = await fs.readdir(HIST_DIR);
        allFiles = histFiles
            .filter(f => f.startsWith('historical-') && f.endsWith('.csv'))
            .map(f => path.join(HIST_DIR, f))
            .sort();
    } catch (e) {
        console.error("Error: Could not read './historical_data' directory. Run download_history.js first.");
        return;
    }

    if (allFiles.length === 0) {
        console.error("Error: No 'historical-*.csv' files found in historical_data/");
        return;
    }

    console.log(`Found ${allFiles.length} monthly log files. Processing data...`);

    // 2. Aggregate and Sort all rows chronologically
    let allRows = [];
    for (const filePath of allFiles) {
        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content.trim().split('\n').slice(1); // Skip headers
        allRows.push(...lines);
        console.log(`- Loaded ${lines.length} records from ${path.basename(filePath)}`);
    }

    if (allRows.length === 0) {
        console.error("Error: Found log files but they contain no data.");
        return;
    }

    // Chronological Sort
    allRows.sort((a, b) => {
        const timeA = new Date(a.split(',')[0]).getTime();
        const timeB = new Date(b.split(',')[0]).getTime();
        return timeA - timeB;
    });

    console.log(`\nTotal Records: ${allRows.length}. Starting simulation...\n`);

    // 3. Define strategies to test
    const strategiesToTest = {
        ...STRATEGIES,
        'VOLUME_BREAKOUT': VolumeBreakoutStrategy,
        'GRID_SCALPER': GridScalperStrategy
    };

    const results = [];
    const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

    for (const [baseName, StrategyClass] of Object.entries(strategiesToTest)) {
        const profiles = ['default', 'conservative', 'aggressive'];
        
        for (const profile of profiles) {
            const name = `${baseName}-${profile}`;
            
            // Skip ALWAYS_BUY default profile variants since it takes no parameters
            if (baseName === 'ALWAYS_BUY' && profile !== 'default') continue;

            let strategyConfig = {};
            let configFound = false;
            
            try {
                const configPath = path.join(__dirname, 'strategies', 'configs', `${name}.json`);
                if (fsSync.existsSync(configPath)) {
                    const rawData = fsSync.readFileSync(configPath, 'utf8');
                    strategyConfig = JSON.parse(rawData);
                    configFound = true;
                }
            } catch(e) {}
            
            // If it's not ALWAYS_BUY and the config wasn't found, skip to avoid duplicate generic tests
            if (baseName !== 'ALWAYS_BUY' && !configFound && profile !== 'default') continue;
            
            const strategy = new StrategyClass(strategyConfig);

        // Wrap with Profit Guard (mimic bot behavior)
        const profitGuardThreshold = parseFloat(process.env.PROFIT_THRESHOLD_PERCENT) || 0.002; 
        const profitGuardedStrategy = new ProfitGuardedStrategy(strategy, profitGuardThreshold);

        let currentAsset = initialAsset;
        let currentAmount = initialAmount;
        let entryPrice = 0; 
        let tradeCount = 0;
        let buyTrades = 0;
        let sellTrades = 0;

        const priceHistory = {
            close: [],
            high: [],
            low: [],
            volume: []
        };

        for (const line of allRows) {
            if (!line) continue;
            const columns = line.split(',');
            if (columns.length < 5) continue;

            // Format: timestamp,open,high,low,close,volume,...
            const [timestamp, o, h, l, c, v] = columns;
            const price = parseFloat(c);
            const high = parseFloat(h);
            const low = parseFloat(l);
            const volume = parseFloat(v);

            if (isNaN(price)) continue;

            priceHistory.close.push(price);
            priceHistory.high.push(high);
            priceHistory.low.push(low);
            priceHistory.volume.push(volume);

            if (priceHistory.close.length > 200) {
                priceHistory.close.shift();
                priceHistory.high.shift();
                priceHistory.low.shift();
                priceHistory.volume.shift();
            }

            if (priceHistory.close.length < 50) continue; 

            // Indicators
            const indicators = strategy.calculateIndicators(priceHistory);
            
            // Check signal via Profit Guard
            const { triggered, type } = profitGuardedStrategy.checkSignal(indicators, price, currentAsset, entryPrice);

            if (triggered) {
                const slippage = 0.005; // 0.5% estimated slippage for realistic backtest
                
                if (type === 'BUY' && currentAsset === 'USDC') {
                    buyTrades++;
                    entryPrice = price; 
                    const solReceived = (currentAmount / price) * (1 - slippage);
                    currentAmount = solReceived;
                    currentAsset = 'SOL';
                } else if (type === 'SELL' && currentAsset === 'SOL') {
                    sellTrades++;
                    entryPrice = price; 
                    const tradableSol = Math.max(0, currentAmount - SOL_RESERVE);
                    const usdcReceived = (tradableSol * price) * (1 - slippage);
                    currentAmount = usdcReceived;
                    currentAsset = 'USDC';
                }
                tradeCount++;
            }
        }

        // Final PNL Calculation - Normalize to SOL
        const lastPrice = parseFloat(allRows[allRows.length - 1].split(',')[4]);
        let finalValueSOL = currentAsset === 'SOL' ? currentAmount : currentAmount / lastPrice;
        
        const pnlPerc = ((finalValueSOL - initialAmount) / initialAmount) * 100;

        results.push({
            name,
            pnl: pnlPerc.toFixed(2) + '%',
            trades: tradeCount,
            finalSol: finalValueSOL.toFixed(2)
        });

        console.log(`- ${name.padEnd(35)}: ${pnlPerc.toFixed(2).padStart(6)}% | Trades: ${tradeCount}`);
        }
    }

    console.log(`\n========================================================`);
    console.table(results);
    console.log(`========================================================\n`);
}

runBacktest();
