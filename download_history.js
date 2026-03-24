import fs from 'fs/promises';
import path from 'path';

/**
 * Historical Data Downloader for Solana (SOL/USDT)
 * Fetches 1-minute klines from Binance API and formats them for the backtest engine.
 * 
 * Usage: node download_history.js <startDate_ISO> <numDays>
 * Example: node download_history.js 2024-03-01 7
 */

async function downloadHistory() {
    const startDateStr = process.argv[2];
    const numDays = parseFloat(process.argv[3]);

    if (!startDateStr || isNaN(numDays)) {
        console.log("Usage: node download_history.js <startDate_YYYY-MM-DD> <numDays>");
        console.log("Example: node download_history.js 2024-03-01 7");
        return;
    }

    const DATA_DIR = './historical_data';
    const symbol = 'SOLUSDT';
    const interval = '1m';
    const limit = 1000; // Binance max limit per request

    const startTime = new Date(startDateStr).getTime();
    if (isNaN(startTime)) {
        console.error("Invalid start date format. Use YYYY-MM-DD.");
        return;
    }

    const endTime = startTime + (numDays * 24 * 60 * 60 * 1000);
    const now = Date.now();
    const actualEndTime = Math.min(endTime, now);

    console.log(`\n========================================================`);
    console.log(`   SOLANA HISTORICAL DATA DOWNLOADER`);
    console.log(`   Symbol: ${symbol} | Interval: ${interval}`);
    console.log(`   Period: ${new Date(startTime).toISOString()} to ${new Date(actualEndTime).toISOString()}`);
    console.log(`========================================================\n`);

    let currentStartTime = startTime;
    let allData = [];
    const fileName = `historical-${startDateStr}-${numDays}d.csv`;
    const filePath = path.join(DATA_DIR, fileName);

    // Create data_logs directory if it doesn't exist
    await fs.mkdir(DATA_DIR, { recursive: true });

    while (currentStartTime < actualEndTime) {
        const url = `https://api.binance.us/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${currentStartTime}&limit=${limit}`;
        
        try {
            const response = await fetch(url);
            if (!response.ok) {
                const errorText = await response.text();
                console.error(`API Error (Status ${response.status}): ${errorText}`);
                break;
            }
            const data = await response.json();

            if (!Array.isArray(data) || data.length === 0) {
                console.log("No more data returned from API.");
                break;
            }

            // data format: [ [openTime, open, high, low, close, volume, closeTime, ...], ... ]
            for (const kline of data) {
                const openTime = kline[0];
                const closePrice = kline[4];
                
                if (openTime >= actualEndTime) break;

                // Format: timestamp,price,rsi,macd_h,vwap,impact_pct
                // Indicators are set to 0 and will be recalculated by backtest.js
                allData.push(`${new Date(openTime).toISOString()},${closePrice},0,0,0,0`);
            }

            const lastOpenTime = data[data.length - 1][0];
            console.log(`Fetched until ${new Date(lastOpenTime).toLocaleString()}... (${allData.length} records)`);

            // Move to the next chunk
            currentStartTime = lastOpenTime + 1;

            // Simple rate limit protection
            await new Promise(resolve => setTimeout(resolve, 100));

        } catch (error) {
            console.error(`Error fetching data: ${error.message}`);
            break;
        }
    }

    if (allData.length > 0) {
        const header = "timestamp,price,rsi,macd_h,vwap,impact_pct\n";
        await fs.writeFile(filePath, header + allData.join('\n'));
        console.log(`\nSuccess! Downloaded ${allData.length} records to ${filePath}`);
        console.log(`You can now run 'node backtest.js' to include this data in your simulations.`);
    } else {
        console.log("\nNo data was downloaded.");
    }
}

downloadHistory();
