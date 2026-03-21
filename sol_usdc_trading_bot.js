import url from 'url';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { RSI, MACD, VWAP } from 'technicalindicators';
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import dotenv from 'dotenv';

dotenv.config();

// Setup Logger (Rotate every hour)
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.printf(({ message }) => message),
  transports: [
    new winston.transports.Console(),
    new DailyRotateFile({
      filename: 'logs/trading-bot-%DATE%.log',
      datePattern: 'YYYY-MM-DD-HH', // Hourly rotation
      zippedArchive: false,
      maxSize: '20m',
      maxFiles: '14d'
    })
  ]
});

const STATE_FILE = 'trading_state.json';

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

const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL) || 30000;   // Environment variable or 30 seconds default
const SLIPPAGE_BPS = 50;       // 0.5% slippage
const SOL_RESERVE = 0.05;      // Amount of SOL to always leave untouched for gas

// Strategy Configuration
const BUY_RSI = parseInt(process.env.BUY_RSI_THRESHOLD) || 40;
const SELL_RSI = parseInt(process.env.SELL_RSI_THRESHOLD) || 60;

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export class JupiterMonitor {
  async saveState(state) {
    await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
    logger.info(`Session State safely persisted to ${STATE_FILE}`);
  }

  async loadState() {
    if (existsSync(STATE_FILE)) {
      const data = await fs.readFile(STATE_FILE, 'utf8');
      return JSON.parse(data);
    }
    return null;
  }

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
    const apiUrl = 'https://api.binance.us/api/v3/klines?symbol=SOLUSDT&interval=1m&limit=100';
    const response = await fetch(apiUrl);
    const data = await response.json();
    
    if (!Array.isArray(data)) {
      throw new Error(`Failed to fetch klines from Binance API: ${JSON.stringify(data)}`);
    }

    return {
      high: data.map(candle => parseFloat(candle[2])),
      low: data.map(candle => parseFloat(candle[3])),
      close: data.map(candle => parseFloat(candle[4])),
      volume: data.map(candle => parseFloat(candle[5])),
    };
  }

  calculateIndicators(marketData) {
    const rsiInput = { values: marketData.close, period: 14 };
    const rsiResult = RSI.calculate(rsiInput);

    const macdInput = {
      values: marketData.close,
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9,
      SimpleMAOscillator: false,
      SimpleMASignal: false
    };
    const macdResult = MACD.calculate(macdInput);

    const vwapInput = {
      high: marketData.high,
      low: marketData.low,
      close: marketData.close,
      volume: marketData.volume
    };
    const vwapResult = VWAP.calculate(vwapInput);

    const latestRsi = rsiResult[rsiResult.length - 1];
    const latestMacd = macdResult[macdResult.length - 1];
    const latestVwap = vwapResult[vwapResult.length - 1];

    return { latestRsi, latestMacd, latestVwap };
  }

  async runMonitor(cliAsset, cliAmount) {
    let state = await this.loadState();

    logger.info(`\n================ SIMULATION TRADING BOT ================`);
    
    if (!state) {
      if (!cliAsset || !cliAmount || isNaN(parseFloat(cliAmount))) {
        throw new Error('No state file found. You must provide initial arguments. Example: node sol_usdc_trading_bot.js SOL 3');
      }

      state = {
        initialAsset: cliAsset.toUpperCase(),
        initialAmount: parseFloat(cliAmount),
        currentAsset: cliAsset.toUpperCase(),
        currentAmount: parseFloat(cliAmount),
        reservedSol: 0,
        updatedAt: new Date().toISOString()
      };
      
      await this.saveState(state);
      logger.info(`Starting completely fresh virtual session: ${state.initialAmount} ${state.initialAsset}`);
    } else {
      logger.info(`Loaded previous trading session from ${STATE_FILE}. Resuming...`);
      logger.info(`Initial Portfolio was: ${state.initialAmount.toFixed(4)} ${state.initialAsset}`);
      logger.info(`Restored active position: ${state.currentAmount.toFixed(4)} ${state.currentAsset}`);
      if (state.reservedSol > 0) {
        logger.info(`Found Reserved SOL: ${state.reservedSol} SOL`);
      }
      logger.info(`\n`);
    }

    let { initialAsset, initialAmount } = state;
    let startToken = state.currentAsset;
    let targetToken = startToken === 'SOL' ? 'USDC' : 'SOL';
    let currentAmount = state.currentAmount;
    let reservedSol = state.reservedSol || 0;

    if (!TOKENS[startToken] || !TOKENS[targetToken]) {
      throw new Error(`Invalid token. Supported tokens are SOL and USDC.`);
    }

    if (startToken === 'SOL') {
      logger.info(`Goal: Monitor the market to find the best time to swap your SOL to USDC.`);
      logger.info(`Condition Criteria: Wait for SOL to be OVERBOUGHT (RSI > ${SELL_RSI}) AND MACD Histogram < 0 AND Price drops below VWAP.`);
    } else {
      logger.info(`Goal: Monitor the market to find the best time to swap your USDC to SOL.`);
      logger.info(`Condition Criteria: Wait for SOL to be OVERSOLD (RSI < ${BUY_RSI}) AND MACD Histogram > 0 AND Price climbs above VWAP.`);
    }
    
    logger.info(`Polling every ${POLL_INTERVAL/1000} seconds...\n`);

    while (true) {
      try {
        // Enforce SOL gas fee reserve
        let tradeAmount = currentAmount;
        if (startToken === 'SOL') {
          tradeAmount = currentAmount - SOL_RESERVE;
          if (tradeAmount <= 0) {
            logger.error(`[${new Date().toLocaleTimeString()}] Insufficient SOL balance to trade while reserving ${SOL_RESERVE} SOL for fees (Current Balance: ${currentAmount} SOL).`);
            await delay(POLL_INTERVAL);
            continue;
          }
        }

        let marketData;
        try {
          marketData = await this.fetchMarketData();
        } catch (e) {
          logger.warn(`[${new Date().toLocaleTimeString()}] Market data temporarily unavailable (Binance). Retrying in ${POLL_INTERVAL/1000}s...`);
          await delay(POLL_INTERVAL);
          continue;
        }

        const { latestRsi, latestMacd, latestVwap } = this.calculateIndicators(marketData);

        let priceQuote, solPriceQuote;
        try {
          priceQuote = await this.getQuote(startToken, targetToken, tradeAmount.toString());
          solPriceQuote = await this.getQuote('SOL', 'USDC', '1');
        } catch (e) {
          logger.warn(`[${new Date().toLocaleTimeString()}] Trading quotes temporarily unavailable (Jupiter). Retrying in ${POLL_INTERVAL/1000}s...`);
          await delay(POLL_INTERVAL);
          continue;
        }

        const receiveAmount = parseInt(priceQuote.outAmount) / (10 ** TOKENS[targetToken].decimals);
        const livePrice = parseInt(solPriceQuote.outAmount) / (10 ** TOKENS.USDC.decimals);

        let currentPnl = 0;
        let pnlPercentage = 0;
        
        let totalSol = 0;
        let totalUsdc = 0;

        if (startToken === 'SOL') {
          totalSol = currentAmount;
          totalUsdc = currentAmount * livePrice;
        } else {
          // startToken is USDC, which means we have reservedSol stored safely from the original swap
          let reverseQuote;
          try {
            reverseQuote = await this.getQuote('USDC', 'SOL', currentAmount.toString());
          } catch (e) {
            logger.warn(`[${new Date().toLocaleTimeString()}] Price fetch failed. Retrying...`);
            await delay(POLL_INTERVAL);
            continue;
          }
          const usdcToSol = parseInt(reverseQuote.outAmount) / (10 ** TOKENS.SOL.decimals);
          totalSol = usdcToSol + reservedSol;
          totalUsdc = currentAmount + (reservedSol * livePrice);
        }

        if (initialAsset === 'SOL') {
          currentPnl = totalSol - initialAmount;
        } else {
          currentPnl = totalUsdc - initialAmount;
        }
        
        pnlPercentage = (currentPnl / initialAmount) * 100;

        const pnlStr = currentPnl >= 0 ? `+${currentPnl.toFixed(4)}` : `${currentPnl.toFixed(4)}`;
        const pnlPercStr = pnlPercentage >= 0 ? `+${pnlPercentage.toFixed(2)}%` : `${pnlPercentage.toFixed(2)}%`;

        let signalTriggered = false;
        let signalType = '';
        let rsiMet = false;
        let macdMet = false;
        let vwapMet = false;

        if (startToken === 'SOL') {
          rsiMet = latestRsi > SELL_RSI;
          macdMet = latestMacd.histogram < 0;
          vwapMet = livePrice < latestVwap;
          
          if (rsiMet && macdMet && vwapMet) {
            signalTriggered = true;
            signalType = 'SELL';
          }
        } else if (startToken === 'USDC') {
          rsiMet = latestRsi < BUY_RSI;
          macdMet = latestMacd.histogram > 0;
          vwapMet = livePrice > latestVwap;
          
          if (rsiMet && macdMet && vwapMet) {
            signalTriggered = true;
            signalType = 'BUY';
          }
        }

        const rsiIcon = rsiMet ? '🟢' : '🔴';
        const macdIcon = macdMet ? '🟢' : '🔴';
        const vwapIcon = vwapMet ? '🟢' : '🔴';

        let signalIcon = '';
        if (signalTriggered) {
          signalIcon = signalType === 'SELL' ? ' 📉' : ' 📈';
        }

        const timeStr = new Date().toLocaleTimeString().padStart(11, ' ');
        const rsiStr = latestRsi.toFixed(1).padStart(4, ' ');
        const macdStr = (latestMacd.histogram || 0).toFixed(3).padStart(6, ' ');
        const priceStr = livePrice.toFixed(2).padStart(6, ' ');
        const vwapStr = latestVwap.toFixed(2).padStart(6, ' ');
        const holdingStr = currentAmount.toFixed(4).padStart(9, ' ');
        const valStr = receiveAmount.toFixed(4).padStart(9, ' ');

        logger.info(`[${timeStr}]${signalIcon} PNL: ${pnlStr.padStart(8, ' ')} ${initialAsset.padEnd(4, ' ')} (${pnlPercStr.padStart(7, ' ')}) | Holding: ${holdingStr} ${startToken.padEnd(4, ' ')} | Val: ~${valStr} ${targetToken.padEnd(4, ' ')} | Price: $${priceStr} | VWAP: $${vwapStr} ${vwapIcon} | RSI: ${rsiStr} ${rsiIcon} | MACD: ${macdStr} ${macdIcon}`);

        if (signalTriggered) {
          if (signalType === 'SELL') {
            logger.info(`\n🚨 SELL RECOMMENDATION ALARM 🚨`);
            logger.info(`SOL is OVERBOUGHT (RSI: ${latestRsi.toFixed(2)} > ${SELL_RSI}), MACD crossed down, AND Price ($${livePrice.toFixed(2)}) is confirmed below VWAP ($${latestVwap.toFixed(2)})!`);
          } else {
            logger.info(`\n🚨 BUY RECOMMENDATION ALARM 🚨`);
            logger.info(`SOL is OVERSOLD (RSI: ${latestRsi.toFixed(2)} < ${BUY_RSI}), MACD crossed up, AND Price ($${livePrice.toFixed(2)}) safely cleared VWAP ($${latestVwap.toFixed(2)})!`);
          }
        }

        if (signalTriggered) {
          logger.info(`Execute your manual swap to ${targetToken} right now to secure a statistically higher win rate!`);
          logger.info(`\x07`);
          
          logger.info(`\n================ STATE FLIP ================`);
          
          if (startToken === 'SOL') {
            logger.info(`Assuming you successfully swapped ${tradeAmount.toFixed(4)} SOL (Leaving ${SOL_RESERVE} SOL for fees) for ${receiveAmount.toFixed(4)} USDC.`);
            currentAmount = receiveAmount;
            reservedSol = SOL_RESERVE;
          } else {
            logger.info(`Assuming you successfully swapped ${currentAmount.toFixed(4)} USDC for ${receiveAmount.toFixed(4)} SOL.`);
            currentAmount = receiveAmount + reservedSol;
            logger.info(`Sweeping ${reservedSol.toFixed(4)} SOL reserve back into your active trading balance. New Total: ${currentAmount.toFixed(4)} SOL.`);
            reservedSol = 0;
          }

          logger.info(`The bot will now automatically start hunting for the reverse swap target!`);
          
          startToken = targetToken;
          targetToken = startToken === 'SOL' ? 'USDC' : 'SOL';
          
          state.currentAsset = startToken;
          state.currentAmount = currentAmount;
          state.reservedSol = reservedSol;
          state.updatedAt = new Date().toISOString();
          await this.saveState(state);

          if (startToken === 'SOL') {
            logger.info(`Condition Criteria: Wait for SOL to be OVERBOUGHT (RSI > ${SELL_RSI}) AND MACD Hist < 0 AND Price < VWAP.\n`);
          } else {
            logger.info(`Condition Criteria: Wait for SOL to be OVERSOLD (RSI < ${BUY_RSI}) AND MACD Hist > 0 AND Price > VWAP.\n`);
          }
          
          await delay(60000);
          continue; 
        }

      } catch (err) {
        logger.error(`[${new Date().toLocaleTimeString()}] Error during polling: ${err.message}`);
      }
      
      await delay(POLL_INTERVAL);
    }
  }
}

async function main() {
  const asset = process.argv[2]; 
  const amount = process.argv[3];

  try {
    const monitor = new JupiterMonitor();
    await monitor.runMonitor(asset, amount);
  } catch (error) {
    console.error(`Fatal Monitor Error: ${error.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === url.pathToFileURL(process.argv[1]).href) {
  main();
}
