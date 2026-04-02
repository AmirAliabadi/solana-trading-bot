import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import url from 'url';
import dotenv from 'dotenv';
import { STRATEGIES, TOKENS, SOL_RESERVE } from './sol_usdc_trading_bot.js';
import { ProfitGuardedStrategy } from './strategies/ProfitGuardedStrategy.js';
import { VolumeBreakoutStrategy } from './strategies/VolumeBreakoutStrategy.js';
import { GridScalperStrategy } from './strategies/GridScalperStrategy.js';
import { DynamicTrailingStrategy } from './strategies/DynamicTrailingStrategy.js';
import { FibonacciStrategy } from './strategies/FibonacciStrategy.js';

dotenv.config();

async function runBacktest() {
    // Smart Argument Parsing
    let initialAsset = 'SOL';
    let initialAmount = 60;
    let targetInterval = '1m';

    let targetStrategy = null;
    let targetProfile = null;
    let targetStartDate = null;

    const cleanArgs = [];
    for (let i = 2; i < process.argv.length; i++) {
        if (process.argv[i] === '--strategy') {
            targetStrategy = process.argv[i+1]?.toUpperCase();
            i++;
        } else if (process.argv[i] === '--config' || process.argv[i] === '--profile') {
            targetProfile = process.argv[i+1]?.toLowerCase();
            i++;
        } else if (process.argv[i] === '--interval') {
            targetInterval = process.argv[i+1]?.toLowerCase();
            i++;
        } else if (process.argv[i] === '--start-date') {
            targetStartDate = process.argv[i+1];
            i++;
        } else {
            cleanArgs.push(process.argv[i]);
        }
    }

    const arg1 = cleanArgs[0];
    const arg2 = cleanArgs[1];
    const arg3 = cleanArgs[2];

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
    console.log(`   SOL-USDC BACKTESTING ENGINE`);
    console.log(`   Interval: ${targetInterval} | Initial Balance: ${initialAmount} ${initialAsset}`);
    if (targetStrategy) console.log(`   Strategy: ${targetStrategy} ${targetProfile ? `| Config: ${targetProfile}` : ''}`);
    else console.log(`   Strategy: ALL STRATEGIES`);
    console.log(`   Target Directory: ${HIST_DIR}`);
    if (targetStartDate) console.log(`   Start Date: ${targetStartDate}`);
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

    if (targetStartDate) {
        const startTime = new Date(targetStartDate).getTime();
        if (!isNaN(startTime)) {
            allRows = allRows.filter(row => {
                const rowTime = new Date(row.split(',')[0]).getTime();
                return rowTime >= startTime;
            });
            console.log(`\nFiltered data starting from ${new Date(startTime).toISOString()}`);
        } else {
            console.warn(`\nWarning: Invalid --start-date format '${targetStartDate}'. Ignoring.`);
        }
    }

    console.log(`\nTotal Records: ${allRows.length}. Starting simulation...\n`);

    const chartData = {
        interval: targetInterval,
        times: [],
        prices: [],
        trades: {}
    };

    // Pre-fill base times and prices for the chart
    for (const line of allRows) {
        if (!line) continue;
        const columns = line.split(',');
        if (columns.length >= 5) {
            chartData.times.push(columns[0]);
            chartData.prices.push(parseFloat(columns[4]));
        }
    }

    // 3. Define strategies to test
    const allStrategies = {
        ...STRATEGIES,
        'VOLUME_BREAKOUT': VolumeBreakoutStrategy,
        'GRID_SCALPER': GridScalperStrategy,
        'DYNAMIC_TRAILING': DynamicTrailingStrategy,
        'FIBONACCI': FibonacciStrategy
    };

    const strategiesToTest = {};
    if (targetStrategy) {
        if (allStrategies[targetStrategy]) {
            strategiesToTest[targetStrategy] = allStrategies[targetStrategy];
        } else {
            console.error(`Error: Strategy ${targetStrategy} not found in STRATEGIES.`);
            return;
        }
    } else {
        Object.assign(strategiesToTest, allStrategies);
    }

    const results = [];
    const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

    for (const [baseName, StrategyClass] of Object.entries(strategiesToTest)) {
        let profiles = ['default', 'conservative', 'aggressive'];
        if (targetProfile) {
            profiles = [targetProfile];
        }
        
        for (const profile of profiles) {
            const name = `${baseName}-${profile}`;
            
            // Skip ALWAYS_BUY default profile variants since it takes no parameters
            if (baseName === 'ALWAYS_BUY' && profile !== 'default' && !targetProfile) continue;

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
            
            chartData.trades[name] = [];

        // Wrap with Profit Guard (mimic bot behavior)
        const profitGuardThreshold = parseFloat(process.env.PROFIT_THRESHOLD_PERCENT) || 0.2; 
        const requireBuyProfit = process.env.REQUIRE_BUY_PROFIT === 'true';
        const profitGuardedStrategy = new ProfitGuardedStrategy(strategy, profitGuardThreshold, requireBuyProfit);

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
            
            // Anchor entry price to realistic starting live price like the real bot
            if (currentAsset === 'SOL' && entryPrice === 0) {
                entryPrice = price;
            }

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
                    chartData.trades[name].push({ time: timestamp, price: price, type: 'BUY' });
                } else if (type === 'SELL' && currentAsset === 'SOL') {
                    sellTrades++;
                    entryPrice = price; 
                    const tradableSol = Math.max(0, currentAmount - SOL_RESERVE);
                    const usdcReceived = (tradableSol * price) * (1 - slippage);
                    currentAmount = usdcReceived;
                    currentAsset = 'USDC';
                    chartData.trades[name].push({ time: timestamp, price: price, type: 'SELL' });
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

    // Generate Chart HTML
    console.log(`Generating interactive chart HTML...`);
    const htmlContent = `
<!DOCTYPE html>
<html>
<head>
    <title>Backtest Chart - ${chartData.interval}</title>
    <script src="https://cdn.plot.ly/plotly-2.27.0.min.js"></script>
    <style>
        body { margin: 0; padding: 0; background-color: #111; color: #fff; font-family: sans-serif; }
        #chart { width: 100vw; height: 100vh; }
    </style>
</head>
<body>
    <div id="chart"></div>
    <script>
        const chartData = ${JSON.stringify(chartData)};
        
        const traces = [];
        
        traces.push({
            x: chartData.times,
            y: chartData.prices,
            type: 'scatter',
            mode: 'lines',
            name: 'SOL Price',
            line: {color: '#17BECF', width: 2}
        });
        
        let isFirst = true;
        for (const [strategyName, trades] of Object.entries(chartData.trades)) {
            if (trades.length === 0) continue;
            
            const buyTimes = trades.filter(t => t.type === 'BUY').map(t => t.time);
            const buyPrices = trades.filter(t => t.type === 'BUY').map(t => t.price);
            
            const sellTimes = trades.filter(t => t.type === 'SELL').map(t => t.time);
            const sellPrices = trades.filter(t => t.type === 'SELL').map(t => t.price);
            
            if (buyTimes.length > 0) {
                traces.push({
                    x: buyTimes,
                    y: buyPrices,
                    type: 'scatter',
                    mode: 'markers',
                    name: strategyName + ' BUY',
                    marker: {color: '#00FA9A', size: 12, symbol: 'triangle-up', line: {color: '#000', width: 1}},
                    visible: isFirst ? true : 'legendonly'
                });
            }
            
            if (sellTimes.length > 0) {
                traces.push({
                    x: sellTimes,
                    y: sellPrices,
                    type: 'scatter',
                    mode: 'markers',
                    name: strategyName + ' SELL',
                    marker: {color: '#FF6347', size: 12, symbol: 'triangle-down', line: {color: '#000', width: 1}},
                    visible: isFirst ? true : 'legendonly'
                });
            }
            
            isFirst = false;
        }
        
        const layout = {
            title: 'SOL-USDC Backtest (' + chartData.interval + ')',
            plot_bgcolor: '#111',
            paper_bgcolor: '#111',
            font: { color: '#fff' },
            xaxis: { title: 'Time', gridcolor: '#444' },
            yaxis: { title: 'Price (USDC)', gridcolor: '#444' },
            legend: { x: 1.05, y: 1 }
        };
        
        Plotly.newPlot('chart', traces, layout);
    </script>
</body>
</html>
`;
    const chartPath = path.join(process.cwd(), `backtest_chart_${targetInterval}.html`);
    fsSync.writeFileSync(chartPath, htmlContent);
    console.log(`Chart successfully saved to: ${chartPath}\n`);
}

runBacktest();
