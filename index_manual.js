import url from 'url';
import { RSI, MACD } from 'technicalindicators';

// Mints and Token configuration
const TOKENS = {
  SOL: {
    mint: 'So11111111111111111111111111111111111111112',
    decimals: 9,
  },
  USDC: {
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    decimals: 6,
  }
};

const POLL_INTERVAL = 30000;   // 30 seconds delay between updates
const SLIPPAGE_BPS = 50;       // 0.5% slippage

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export class JupiterMonitor {
  async getQuote(inputToken, outputToken, amountStr, slippageBps = SLIPPAGE_BPS) {
    const input = TOKENS[inputToken];
    const output = TOKENS[outputToken];
    
    // Parse the amount string and multiply by 10^decimals to get atomic units
    const amountInAtomic = Math.floor(parseFloat(amountStr) * (10 ** input.decimals));
    const apiUrl = `https://public.jupiterapi.com/quote?inputMint=${input.mint}&outputMint=${output.mint}&amount=${amountInAtomic}&slippageBps=${slippageBps}`;
    
    const response = await fetch(apiUrl);
    const quoteResponse = await response.json();
    
    if (quoteResponse.error) {
      throw new Error(`Jupiter Quote Error: ${quoteResponse.error}`);
    }
    
    return quoteResponse;
  }

  async fetchMarketData() {
    // Top 100 1-minute candles for SOLUSDT (Use Binance.US domain for open access)
    const apiUrl = 'https://api.binance.us/api/v3/klines?symbol=SOLUSDT&interval=1m&limit=100';
    const response = await fetch(apiUrl);
    const data = await response.json();
    
    if (!Array.isArray(data)) {
      throw new Error(`Failed to fetch klines from Binance API: ${JSON.stringify(data)}`);
    }

    // Binance kline format: [Open Time, Open, High, Low, Close, Volume, ...]
    const closePrices = data.map(candle => parseFloat(candle[4]));
    return closePrices;
  }

  calculateIndicators(closePrices) {
    const rsiInput = { values: closePrices, period: 14 };
    const rsiResult = RSI.calculate(rsiInput);

    const macdInput = {
      values: closePrices,
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9,
      SimpleMAOscillator: false,
      SimpleMASignal: false
    };
    const macdResult = MACD.calculate(macdInput);

    // Get the latest values
    const latestRsi = rsiResult[rsiResult.length - 1];
    const latestMacd = macdResult[macdResult.length - 1]; // contains { MACD, signal, histogram }

    return { latestRsi, latestMacd };
  }

  async runMonitor(initialAsset, initialAmount) {
    let startToken = initialAsset.toUpperCase();
    let targetToken = startToken === 'SOL' ? 'USDC' : 'SOL';
    let currentAmount = parseFloat(initialAmount);

    if (!TOKENS[startToken] || !TOKENS[targetToken]) {
      throw new Error(`Invalid token. Supported tokens are SOL and USDC.`);
    }

    console.log(`\n================ TA MONITORING LOOP ================`);
    
    if (startToken === 'SOL') {
      console.log(`Goal: Monitor the market to find the best time to swap your SOL to USDC.`);
      console.log(`Condition Criteria: Wait for SOL to be OVERBOUGHT (RSI > 70) AND MACD Histogram turns negative (Bearish reversal).`);
    } else {
      console.log(`Goal: Monitor the market to find the best time to swap your USDC to SOL.`);
      console.log(`Condition Criteria: Wait for SOL to be OVERSOLD (RSI < 30) AND MACD Histogram turns positive (Bullish reversal).`);
    }
    
    console.log(`Polling every ${POLL_INTERVAL/1000} seconds...\n`);

    // Phase 2: Polling Loop
    while (true) {
      try {
        const closePrices = await this.fetchMarketData();
        const { latestRsi, latestMacd } = this.calculateIndicators(closePrices);

        const currentAmountStr = currentAmount.toString();
        const priceQuote = await this.getQuote(startToken, targetToken, currentAmountStr);
        const receiveAmount = parseInt(priceQuote.outAmount) / (10 ** TOKENS[targetToken].decimals);

        console.log(`[${new Date().toLocaleTimeString()}] Holding: ${currentAmount.toFixed(4)} ${startToken} | Market Value: ~${receiveAmount.toFixed(4)} ${targetToken} | SOL RSI: ${latestRsi.toFixed(2)} | MACD Hist: ${latestMacd.histogram?.toFixed(4) || 0}`);

        let signalTriggered = false;

        if (startToken === 'SOL') {
          // WE HAVE SOL, WE WANT TO SELL
          if (latestRsi > 70 && latestMacd.histogram < 0) {
            console.log(`\n🚨 SELL RECOMMENDATION ALARM 🚨`);
            console.log(`SOL is heavily OVERBOUGHT (RSI: ${latestRsi.toFixed(2)}) and MACD is showing a BEARISH reversal (Hist: ${latestMacd.histogram.toFixed(4)})!`);
            signalTriggered = true;
          }
        } else if (startToken === 'USDC') {
          // WE HAVE USDC, WE WANT TO BUY
          if (latestRsi < 30 && latestMacd.histogram > 0) {
            console.log(`\n🚨 BUY RECOMMENDATION ALARM 🚨`);
            console.log(`SOL is heavily OVERSOLD (RSI: ${latestRsi.toFixed(2)}) and MACD is showing a BULLISH reversal (Hist: ${latestMacd.histogram.toFixed(4)})!`);
            signalTriggered = true;
          }
        }

        if (signalTriggered) {
          console.log(`Execute your manual swap to ${targetToken} right now to secure a statistically higher win rate!`);
          console.log(`\x07`); // Trigger system beep
          
          console.log(`\n================ STATE FLIP ================`);
          console.log(`Assuming you successfully swapped ${currentAmount.toFixed(4)} ${startToken} for ${receiveAmount.toFixed(4)} ${targetToken}.`);
          console.log(`The bot will now automatically start hunting for the reverse swap target!`);
          
          // Swap states
          currentAmount = receiveAmount; // Track the new portfolio balances
          startToken = targetToken;
          targetToken = startToken === 'SOL' ? 'USDC' : 'SOL';
          
          if (startToken === 'SOL') {
            console.log(`Condition Criteria: Wait for SOL to be OVERBOUGHT (RSI > 70) AND MACD Histogram turns negative.\n`);
          } else {
            console.log(`Condition Criteria: Wait for SOL to be OVERSOLD (RSI < 30) AND MACD Histogram turns positive.\n`);
          }
          
          // Wait 60 seconds before polling again to prevent duplicate alarms on the same candle
          await delay(60000);
          continue; 
        }

      } catch (err) {
        console.error(`[${new Date().toLocaleTimeString()}] Error during polling: ${err.message}`);
      }
      
      await delay(POLL_INTERVAL);
    }
  }
}

async function main() {
  const asset = process.argv[2];
  const amount = process.argv[3];

  if (!asset || !amount || isNaN(parseFloat(amount))) {
    console.error('Usage: node index_manual.js <HoldingsAsset> <Amount>');
    console.error('Example (You hold 3 SOL): node index_manual.js SOL 3');
    console.error('Example (You hold 150 USDC): node index_manual.js USDC 150');
    process.exit(1);
  }

  try {
    const monitor = new JupiterMonitor();
    await monitor.runMonitor(asset, amount);
  } catch (error) {
    console.error('Fatal Monitor Error:', error.message);
    process.exit(1);
  }
}

// Check if script is being run directly (ESM way)
if (process.argv[1] && import.meta.url === url.pathToFileURL(process.argv[1]).href) {
  main();
}
