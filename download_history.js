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
    const intervalArg = process.argv[4] || '1m';

    const validIntervals = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d', '3d', '1w', '1M'];

    if (!startDateStr || isNaN(numDays)) {
        console.log("Usage: node download_history.js <startDate_YYYY-MM-DD> <numDays> [interval]");
        console.log("Example 1 (Default 1m): node download_history.js 2025-11-01 150");
        console.log("Example 2 (Hourly)    : node download_history.js 2025-11-01 150 1h");
        console.log(`Valid Intervals: ${validIntervals.join(', ')}`);
        return;
    }

    if (!validIntervals.includes(intervalArg)) {
        console.error(`Invalid interval. Supported intervals: ${validIntervals.join(', ')}`);
        return;
    }

    const DATA_DIR = `./historical_data/${intervalArg}`;
    const symbol = 'SOLUSDT';
    const interval = intervalArg;
    const limit = 1000; // Binance max limit per request

    const startTime = new Date(startDateStr).getTime();
    if (isNaN(startTime)) {
        console.error("Invalid start date format. Use YYYY-MM-DD.");
        return;
    }

    const totalEndTime = startTime + (numDays * 24 * 60 * 60 * 1000);
    const now = Date.now();
    const actualEndTime = Math.min(totalEndTime, now);

    console.log(`\n========================================================`);
    console.log(`   SOLANA HISTORICAL DATA DOWNLOADER (OHLCV+)`);
    console.log(`   Symbol: ${symbol} | Interval: ${interval} | Output: ${DATA_DIR}`);
    console.log(`   Total Period: ${new Date(startTime).toISOString()} to ${new Date(actualEndTime).toISOString()}`);
    console.log(`========================================================\n`);

    await fs.mkdir(DATA_DIR, { recursive: true });

    let currentStartTime = startTime;
    let currentMonthStr = "";
    let monthData = [];

    const saveMonthData = async (monthStr, data) => {
        if (data.length === 0) return;
        const fileName = `historical-${monthStr}.csv`;
        const filePath = path.join(DATA_DIR, fileName);
        const header = "timestamp,open,high,low,close,volume,quoteVolume,trades,takerBaseVolume,takerQuoteVolume\n";
        await fs.writeFile(filePath, header + data.join('\n'));
        console.log(`✅ Saved ${data.length} records to ${filePath}`);
    };

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

            for (const kline of data) {
                const openTime = kline[0];
                if (openTime >= actualEndTime) break;

                const date = new Date(openTime);
                const monthStr = date.toISOString().slice(0, 7); // "YYYY-MM"

                if (currentMonthStr === "") {
                    currentMonthStr = monthStr;
                } else if (currentMonthStr !== monthStr) {
                    await saveMonthData(currentMonthStr, monthData);
                    monthData = [];
                    currentMonthStr = monthStr;
                }

                // Format: timestamp,open,high,low,close,volume,quoteVolume,trades,takerBaseVolume,takerQuoteVolume
                const row = [
                    date.toISOString(),
                    kline[1], // Open
                    kline[2], // High
                    kline[3], // Low
                    kline[4], // Close
                    kline[5], // Volume
                    kline[7], // Quote Volume
                    kline[8], // Trades
                    kline[9], // Taker Base Volume
                    kline[10] // Taker Quote Volume
                ].join(',');
                
                monthData.push(row);
            }

            const lastOpenTime = data[data.length - 1][0];
            process.stdout.write(`\rPulled until ${new Date(lastOpenTime).toLocaleString()}...`);

            currentStartTime = lastOpenTime + 1;
            await new Promise(resolve => setTimeout(resolve, 50));

        } catch (error) {
            console.error(`\nError fetching data: ${error.message}`);
            break;
        }
    }

    if (monthData.length > 0) {
        console.log(""); // New line after \r
        await saveMonthData(currentMonthStr, monthData);
    }
}

downloadHistory();
