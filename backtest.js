import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';
import { STRATEGIES, TOKENS, SOL_RESERVE } from './sol_usdc_trading_bot.js';
import { ProfitGuardedStrategy } from './strategies/ProfitGuardedStrategy.js';

dotenv.config();

async function runBacktest() {
    const DATA_DIR = './data_logs';
    
    // Smart Argument Parsing (Handle node backtest.js 5000 USDC or node backtest.js USDC 5000)
    let initialAsset = 'USDC';
    let initialAmount = 5000;

    const arg1 = process.argv[2];
    const arg2 = process.argv[3];

    if (arg1) {
        if (!isNaN(parseFloat(arg1))) {
            initialAmount = parseFloat(arg1);
            if (arg2) initialAsset = arg2.toUpperCase();
        } else {
            initialAsset = arg1.toUpperCase();
            if (arg2 && !isNaN(parseFloat(arg2))) initialAmount = parseFloat(arg2);
        }
    }

    console.log(`\n========================================================`);
    console.log(`   SOL-USDC BACKTESTING ENGINE - ALL STRATEGIES`);
    console.log(`   Initial Balance: ${initialAmount} ${initialAsset}`);
    console.log(`========================================================\n`);

    const HIST_DIR = './historical_data';
    
    // 1. Scan for CSV files only in HIST_DIR
    let allFiles = [];
    try {
        const histFiles = await fs.readdir(HIST_DIR);
        allFiles.push(...histFiles.filter(f => f.endsWith('.csv')).map(f => path.join(HIST_DIR, f)));
    } catch (e) {
        console.error("Error: Could not read './historical_data' directory.");
        return;
    }

    if (allFiles.length === 0) {
        console.error("Error: No CSV files found in historical_data/");
        return;
    }

    console.log(`Found ${allFiles.length} log files. Processing data...`);

    // 2. Aggregate and Sort all rows chronologically
    let allRows = [];
    for (const filePath of allFiles) {
        const content = await fs.readFile(filePath, 'utf-8');
        const lines = content.trim().split('\n').slice(1); // Skip headers
        allRows.push(...lines);
    }

    if (allRows.length === 0) {
        console.error("Error: Found log files but they contain no data.");
        return;
    }

    // Sort by timestamp (first column)
    allRows.sort((a, b) => {
        const timeA = new Date(a.split(',')[0]).getTime();
        const timeB = new Date(b.split(',')[0]).getTime();
        return timeA - timeB;
    });

    console.log(`Loaded ${allRows.length} data points. Simulating strategies...\n`);

    // 3. Initialize Strategies and Simulation States
    const results = [];

    for (const [name, StrategyClass] of Object.entries(STRATEGIES)) {
        // Instantiate strategy with keys matching the constructors in strategies/*.js
        const strategy = new StrategyClass({
            BUY_RSI_THRESHOLD: 45,
            SELL_RSI_THRESHOLD: 55,
            MAX_PRICE_IMPACT: 0.1,
            USE_VWAP: true,
            VWAP_OFFSET_PERCENT: 0,
            USE_MACD: true,
            MACD_FAST_PERIOD: 12,
            MACD_SLOW_PERIOD: 26,
            MACD_SIGNAL_PERIOD: 9,
            SIMPLE_BUY_PCT: parseFloat(process.env.SIMPLE_TREND_BUY_PCT) || 3.0,
            SIMPLE_SELL_PCT: parseFloat(process.env.SIMPLE_TREND_SELL_PCT) || 4.0
        });

        let currentAsset = initialAsset;
        let currentAmount = initialAmount;
        let entryPrice = 0; // Initialize entryPrice for profit guarding
        let buyTrades = 0;
        let sellTrades = 0;
        
        // Wrap base strategy with Profit Guard (mimic bot behavior)
        const profitGuardThreshold = parseFloat(process.env.PROFIT_THRESHOLD_PERCENT) || 0.025; 
        const profitGuardedStrategy = new ProfitGuardedStrategy(strategy, profitGuardThreshold);

        // Sliding window for TA (standard 100 points history)
        let priceHistory = {
            close: [],
            high: [],
            low: [],
            volume: []
        };

        for (const line of allRows) {
            if (!line || line.trim() === '') continue;
            const columns = line.split(',');
            if (columns.length < 2) continue;

            const [timestamp, priceStr, rsiStr, macdStr, vwapStr, impactStr] = columns;
            const price = parseFloat(priceStr);
            if (isNaN(price)) continue;

            const impact = parseFloat(impactStr) || 0;

            // Update sliding window with a tiny 0.01% spread for H/L 
            // This prevents indicators from breaking when H=L=C in simple logs
            priceHistory.close.push(price);
            priceHistory.high.push(price * 1.0001); 
            priceHistory.low.push(price * 0.9999);
            priceHistory.volume.push(1);
            if (priceHistory.close.length > 200) {
                priceHistory.close.shift();
                priceHistory.high.shift();
                priceHistory.low.shift();
                priceHistory.volume.shift();
            }

            if (priceHistory.close.length < 50) continue; 

            // Prepare indicators (Prioritize logged data for 100% accuracy, fallback to recalc for new strategies)
            const recalcIndicators = strategy.calculateIndicators(priceHistory); // Use strategy for indicator calculation
            const indicators = {
                ...recalcIndicators,
                // Overwrite with logged values if they aren't zero
                latestRsi: parseFloat(rsiStr) || recalcIndicators.latestRsi || 50,
                latestMacd: { histogram: parseFloat(macdStr) || (recalcIndicators.latestMacd ? recalcIndicators.latestMacd.histogram : 0) },
                latestVwap: parseFloat(vwapStr) || recalcIndicators.latestVwap || price
            };

            // Use the profitGuardedStrategy for simulation
            const { triggered, type, metrics } = profitGuardedStrategy.checkSignal(indicators, price, currentAsset, entryPrice);

            if (triggered) {
                // CAP SLIPPAGE at 1% for backtesting stability. 
                // Some data points may have corrupted 99% impact values due to API hiccups.
                const rawSlippage = (impact / 100) || 0.001;
                const slippage = Math.min(0.01, rawSlippage); 
                
                const oldAmount = currentAmount;
                const oldAsset = currentAsset;

                if (type === 'BUY' && currentAsset === 'USDC') {
                    buyTrades++;
                    entryPrice = price; 
                    const solReceived = (currentAmount / price) * (1 - slippage);
                    currentAmount = Math.max(0, solReceived);
                    currentAsset = 'SOL';
                } else if (type === 'SELL' && currentAsset === 'SOL') {
                    sellTrades++;
                    entryPrice = price; 
                    const tradableSol = Math.max(0, currentAmount - SOL_RESERVE);
                    const usdcReceived = (tradableSol * price) * (1 - slippage);
                    currentAmount = Math.max(0, usdcReceived);
                    currentAsset = 'USDC';
                }

            }
        }

        // Final PNL Calculation
        const lastRow = allRows[allRows.length - 1].split(',');
        const finalPrice = parseFloat(lastRow[1]);
        let finalValue = currentAmount;
        if (currentAsset !== initialAsset) {
            finalValue = initialAsset === 'USDC' ? (currentAmount * finalPrice) : (currentAmount / finalPrice);
        }

        const pnlPerc = ((finalValue - initialAmount) / initialAmount) * 100;
        console.log(`- ${name.padEnd(20)}: ${finalValue.toFixed(2).padStart(10)} ${initialAsset} | Buys: ${buyTrades.toString().padStart(3)} | Sells: ${sellTrades.toString().padStart(3)} | PNL: ${pnlPerc.toFixed(2).padStart(6)}%`);

        results.push({
            Strategy: name,
            Final_Bal: finalValue.toFixed(2),
            Buys: buyTrades,
            Sells: sellTrades,
            PNL_Perc: pnlPerc.toFixed(2) + '%'
        });
    }

    console.log(`\n========================================================\n`);
}

runBacktest();
