import url from 'url';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { RSI, MACD, VWAP } from 'technicalindicators';
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import dotenv from 'dotenv';

// Strategies
import { MeanReversionStrategy } from './strategies/MeanReversionStrategy.js';
import { AlwaysBuyStrategy } from './strategies/AlwaysBuyStrategy.js';
import { TrendFollowingStrategy } from './strategies/TrendFollowingStrategy.js';
import { BollingerBandStrategy } from './strategies/BollingerBandStrategy.js';
import { ProfitGuardedStrategy } from './strategies/ProfitGuardedStrategy.js';
import SimpleTrendStrategy from './strategies/SimpleTrendStrategy.js';
import { VolumeBreakoutStrategy } from './strategies/VolumeBreakoutStrategy.js';
import { GridScalperStrategy } from './strategies/GridScalperStrategy.js';
import { sendDiscordNotification } from './utils/notify.js';

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

// Setup Data Logger (CSV for backtesting, rotate hourly)
const dataLogger = winston.createLogger({
  level: 'info',
  format: winston.format.printf(({ message }) => message),
  transports: [
    new DailyRotateFile({
      filename: 'data_logs/market-feed-%DATE%.csv',
      datePattern: 'YYYY-MM-DD-HH',
      zippedArchive: false,
      maxSize: '20m',
      maxFiles: '14d'
    })
  ]
});

// Setup Trade Logger (Dedicated CSV for successful swaps)
const tradeLogger = winston.createLogger({
  level: 'info',
  format: winston.format.printf(({ message }) => message),
  transports: [
    new DailyRotateFile({
      filename: 'logs/trades-%DATE%.csv',
      datePattern: 'YYYY-MM-DD', // Daily rotation is fine for trades
      zippedArchive: false,
      maxSize: '20m',
      maxFiles: '30d'
    })
  ]
});

// Headers for Trade Logger
tradeLogger.transports[0].on('new', (newFilename) => {
  const headers = 'timestamp,type,inputAmount,inputToken,outputAmount,outputToken,price';
  fs.writeFile(newFilename, headers + '\n').catch(err => console.error('Failed to write Trade CSV header:', err));
});

// A hacky but efficient way to ensure every new CSV file gets a header
dataLogger.transports[0].on('new', (newFilename) => {
  const headers = 'timestamp,price,rsi,macd_h,vwap,impact_pct';
  fs.writeFile(newFilename, headers + '\n').catch(err => console.error('Failed to write CSV header:', err));
});

const STATE_FILE = 'trading_state.json';

// Mints and Token configuration
export const TOKENS = {
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
export const SOL_RESERVE = 0.05;      // Amount of SOL to always leave untouched for gas
const POST_SWAP_DELAY = parseInt(process.env.POST_SWAP_DELAY_MS) || 5000; 

// Strategy Configuration
const BUY_RSI = parseInt(process.env.BUY_RSI_THRESHOLD) || 40;
const SELL_RSI = parseInt(process.env.SELL_RSI_THRESHOLD) || 60;
const MAX_PRICE_IMPACT = parseFloat(process.env.MAX_PRICE_IMPACT) || 0.1;
const USE_VWAP = process.env.USE_VWAP !== 'false'; // Default to true
const VWAP_OFFSET = parseFloat(process.env.VWAP_OFFSET_PERCENT) || 0;

const USE_MACD = process.env.USE_MACD !== 'false'; // Default to true
const MACD_FAST = parseInt(process.env.MACD_FAST_PERIOD) || 12;
const MACD_SLOW = parseInt(process.env.MACD_SLOW_PERIOD) || 26;
const MACD_SIGNAL = parseInt(process.env.MACD_SIGNAL_PERIOD) || 9;

// Simple Trend Configuration
const SIMPLE_BUY_PCT = parseFloat(process.env.SIMPLE_TREND_BUY_PCT) || 3.0;
const SIMPLE_SELL_PCT = parseFloat(process.env.SIMPLE_TREND_SELL_PCT) || 4.0;

const ENABLE_DATA_LOGGING = process.env.ENABLE_DATA_LOGGING === 'true';
const PROFIT_THRESHOLD = parseFloat(process.env.PROFIT_THRESHOLD_PERCENT) || 0;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

export const STRATEGIES = {
  MEAN_REVERSION: MeanReversionStrategy,
  ALWAYS_BUY: AlwaysBuyStrategy,
  TREND_FOLLOWING: TrendFollowingStrategy,
  BOLLINGER_BANDS: BollingerBandStrategy,
  SIMPLE_TREND: SimpleTrendStrategy,
  VOLUME_BREAKOUT: VolumeBreakoutStrategy,
  GRID_SCALPER: GridScalperStrategy
};

const ACTIVE_STRATEGY_NAME = process.env.ACTIVE_STRATEGY || 'MEAN_REVERSION';
const StrategyClass = STRATEGIES[ACTIVE_STRATEGY_NAME] || MeanReversionStrategy;
const baseStrategy = new StrategyClass({
  BUY_RSI,
  SELL_RSI,
  MAX_PRICE_IMPACT,
  USE_VWAP,
  VWAP_OFFSET,
  USE_MACD,
  MACD_FAST,
  MACD_SLOW,
  MACD_SIGNAL,
  SIMPLE_BUY_PCT,
  SIMPLE_SELL_PCT
});

// Wrap with Profit Guard if threshold is set
const activeStrategy = PROFIT_THRESHOLD > 0 
    ? new ProfitGuardedStrategy(baseStrategy, PROFIT_THRESHOLD)
    : baseStrategy;

logger.info(`Strategy Loaded: ${activeStrategy.name}`);
if (ENABLE_DATA_LOGGING) {
  logger.info(`Data Logging: ENABLED (Slicing into data_logs/)`);
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export class JupiterMonitor {
  async saveState(state) {
    await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
    logger.info(`Session State safely persisted to ${STATE_FILE}`);
  }

  async loadState() {
    try {
      if (existsSync(STATE_FILE)) {
        const data = await fs.readFile(STATE_FILE, 'utf8');
        const state = JSON.parse(data);
        
        // Robustness: Handle partial or corrupt state files
        state.initialAsset = state.initialAsset || 'SOL';
        state.initialAmount = state.initialAmount !== undefined ? state.initialAmount : 0;
        state.currentAsset = state.currentAsset || state.initialAsset;
        state.currentAmount = state.currentAmount !== undefined ? state.currentAmount : state.initialAmount;
        state.reservedSol = state.reservedSol || 0;
        state.entryPrice = state.entryPrice || 0;
        
        return state;
      }
    } catch (error) {
      logger.error(`Error loading state: ${error.message}`);
    }
    return null; // Return null if file doesn't exist or error, runMonitor will handle initial state creation
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

  // Calculation of indicators is now handled by the Strategy

  async runMonitor(cliAsset, cliAmount) {
    let state = await this.loadState();

    logger.info(`\n========================================================`);
    logger.info(`   SOL-USDC TRADING BOT - ${activeStrategy.name.toUpperCase()}`);
    logger.info(`========================================================`);

    // CLI Arguments take priority for starting a "fresh" session
    if (cliAsset && cliAmount && !isNaN(parseFloat(cliAmount))) {
      state = {
        initialAsset: cliAsset.toUpperCase(),
        initialAmount: parseFloat(cliAmount),
        currentAsset: cliAsset.toUpperCase(),
        currentAmount: parseFloat(cliAmount),
        reservedSol: 0,
        entryPrice: 0,
        updatedAt: new Date().toISOString()
      };
      await this.saveState(state);
      logger.info(`Starting completely fresh virtual session (CLI Override): ${state.initialAmount} ${state.initialAsset}`);
    } else if (!state) {
      throw new Error('No state file found and no CLI arguments provided. Example: node sol_usdc_trading_bot.js SOL 60');
    } else {
      logger.info(`Loaded previous trading session from ${STATE_FILE}. Resuming...`);
      logger.info(`Initial Portfolio was: ${state.initialAmount.toFixed(4)} ${state.initialAsset}`);
      logger.info(`Restored active position: ${state.currentAmount.toFixed(4)} ${state.currentAsset}`);
      if (state.reservedSol > 0) {
        logger.info(`Found Reserved SOL: ${state.reservedSol} SOL`);
      }
      logger.info(`\n`);
    }

    // Startup Notification
    const startupMsg = `**Bot Initialized**\n**Strategy**: ${activeStrategy.name}\n**Portfolio**: ${state.currentAmount.toFixed(4)} ${state.currentAsset}`;
    sendDiscordNotification(DISCORD_WEBHOOK_URL, startupMsg, 0x3498DB); // Blue for startup

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
      const macdSnippet = USE_MACD ? " AND MACD Histogram < 0" : "";
      const vwapSnippet = USE_VWAP ? " AND Price drops below VWAP" : "";
      logger.info(`Condition Criteria: Wait for SOL to be OVERBOUGHT (RSI > ${SELL_RSI})${macdSnippet}${vwapSnippet}.`);
    } else {
      logger.info(`Goal: Monitor the market to find the best time to swap your USDC to SOL.`);
      const macdSnippet = USE_MACD ? " AND MACD Histogram > 0" : "";
      const vwapSnippet = USE_VWAP ? " AND Price climbs above VWAP" : "";
      logger.info(`Condition Criteria: Wait for SOL to be OVERSOLD (RSI < ${BUY_RSI})${macdSnippet}${vwapSnippet}.`);
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
        const indicators = activeStrategy.calculateIndicators(marketData);

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
        const priceImpact = parseFloat(priceQuote.priceImpactPct) * 100; // Convert to readable percentage

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

        const { triggered, type, metrics } = activeStrategy.checkSignal(indicators, livePrice, startToken, state.entryPrice);
        
        let signalTriggered = triggered;
        const signalType = type;
        
        // Prepare static log parts
        const timeStr = new Date().toLocaleTimeString().padStart(11, ' ');
        const holdingStr = currentAmount.toFixed(4).padStart(9, ' ');
        const impactStr = priceImpact.toFixed(3).padStart(5, ' ');
        const impactIcon = priceImpact > MAX_PRICE_IMPACT ? '🔴' : '🟢';

        const signalPart = signalTriggered ? (signalType === 'SELL' ? '📉 ' : '📈 ') : '   ';
        const timePart = `[${timeStr}]`;
        const pnlPart = `PNL: ${pnlStr.padStart(9, ' ')} ${initialAsset.padEnd(4, ' ')} (${pnlPercStr.padStart(7, ' ')})`;
        const holdPart = `Holding: ${holdingStr} ${startToken.padEnd(5, ' ')}`;
        const impactPart = `Impact: ${impactStr}% ${impactIcon}`;

        const staticParts = `${signalPart}${timePart} | ${pnlPart} | ${holdPart} | ${impactPart}`;
        const strategyParts = activeStrategy.getLogParts(indicators, livePrice, metrics);
        
        // Final Assembly for Terminal
        logger.info(`${staticParts} | ${strategyParts.join(' | ')}`);

        // Extract raw data for CSV and Alarms (safely handling different strategies)
        const latestRsi = metrics.rsiMet ? metrics.rsiMet.val : 0;
        const latestMacdHistogram = metrics.macdMet ? metrics.macdMet.val : 0;
        const latestVwap = metrics.vwapMet ? metrics.vwapMet.val : livePrice;

        // Data Logging for Backtesting (CSV)
        if (ENABLE_DATA_LOGGING) {
          const csvRow = `${new Date().toISOString()},${livePrice.toFixed(4)},${latestRsi.toFixed(4)},${latestMacdHistogram.toFixed(6)},${latestVwap.toFixed(4)},${priceImpact.toFixed(6)}`;
          dataLogger.info(csvRow);
        }

        if (signalTriggered) {
          if (priceImpact > MAX_PRICE_IMPACT) {
            logger.warn(`\n⚠️ LIQUIDITY DEPTH WARNING ⚠️`);
            logger.warn(`TA signals are GREEN, but Price Impact is too high (${priceImpact.toFixed(3)}% > ${MAX_PRICE_IMPACT}%).`);
            logger.warn(`Skipping this trade to prevent slippage loss caused by thin liquidity.`);
            signalTriggered = false; // Block state flip
          } else {
            if (signalType === 'SELL') {
              logger.info(`\n🚨 SELL RECOMMENDATION ALARM 🚨`);
              const macdPart = USE_MACD ? `, MACD crossed down` : ``;
              const vwapPart = USE_VWAP ? `, AND Price ($${livePrice.toFixed(2)}) is confirmed below VWAP ($${latestVwap.toFixed(2)})` : ``;
              logger.info(`SOL is OVERBOUGHT (RSI: ${latestRsi.toFixed(2)} > ${SELL_RSI})${macdPart}${vwapPart}!`);
            } else {
              logger.info(`\n🚨 BUY RECOMMENDATION ALARM 🚨`);
              const macdPart = USE_MACD ? `, MACD crossed up` : ``;
              const vwapPart = USE_VWAP ? `, AND Price ($${livePrice.toFixed(2)}) safely cleared VWAP ($${latestVwap.toFixed(2)})` : ``;
              logger.info(`SOL is OVERSOLD (RSI: ${latestRsi.toFixed(2)} < ${BUY_RSI})${macdPart}${vwapPart}!`);
            }
          }
        }

        if (signalTriggered) {
          logger.info(`Execute your manual swap to ${targetToken} right now to secure a statistically higher win rate!`);
          logger.info(`\x07`);
          
          // Discord Notification
          const discordColor = signalType === 'BUY' ? 0x00FF00 : 0xFF0000;
          const discordTitle = signalType === 'BUY' ? "🟢 BUY RECOMMENDATION" : "🔴 SELL RECOMMENDATION";
          const discordMsg = `**Action**: ${signalType} SOL\n**Price**: $${livePrice.toFixed(2)}\n**PNL**: ${pnlPercStr} (${currentPnl.toFixed(4)} ${initialAsset})\n**Strategy**: ${activeStrategy.name}\n\n*Execute your swap to ${targetToken} now!*`;
          sendDiscordNotification(DISCORD_WEBHOOK_URL, discordMsg, discordColor);
          
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
          
          const executionPrice = signalType === 'SELL' 
            ? receiveAmount / tradeAmount 
            : tradeAmount / receiveAmount; // For BUY, entry price is USDC spent / SOL received

          state.currentAsset = startToken;
          state.currentAmount = currentAmount;
          state.reservedSol = reservedSol;
          state.entryPrice = executionPrice; // Save the ACTUAL price paid/received for profit guarding
          state.updatedAt = new Date().toISOString();
          await this.saveState(state);

          // Log to dedicated trade file (using the REAL execution price)
          const tradeLogEntry = `${new Date().toISOString()},${signalType},${tradeAmount.toFixed(6)},${state.currentAsset === 'SOL' ? 'USDC' : 'SOL'},${receiveAmount.toFixed(6)},${state.currentAsset},${executionPrice.toFixed(4)}`;
          tradeLogger.info(tradeLogEntry);

          if (startToken === 'SOL') {
            logger.info(`Strategy Goal: ${activeStrategy.name}`);
            logger.info(`Hunting for a ${targetToken} flip...\n`);
          } else {
            logger.info(`Strategy Goal: ${activeStrategy.name}`);
            logger.info(`Hunting for a ${targetToken} flip...\n`);
          }
          
          await delay(POST_SWAP_DELAY); // Configurable pause before resuming monitor
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
