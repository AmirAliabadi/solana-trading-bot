import url from 'url';
import fs from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
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
import { SimplePercentStrategy } from './strategies/SimplePercentStrategy.js';
import { DynamicTrailingStrategy } from './strategies/DynamicTrailingStrategy.js';
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
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const MAX_PRICE_IMPACT = parseFloat(process.env.MAX_PRICE_IMPACT) || 0.1;
const ENABLE_DATA_LOGGING = process.env.ENABLE_DATA_LOGGING === 'true';
const PROFIT_THRESHOLD = parseFloat(process.env.PROFIT_THRESHOLD_PERCENT) || 0;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.HEARTBEAT_INTERVAL_MS) || 3600000; // Default: 1 hour

export const STRATEGIES = {
  MEAN_REVERSION: MeanReversionStrategy,
  ALWAYS_BUY: AlwaysBuyStrategy,
  TREND_FOLLOWING: TrendFollowingStrategy,
  BOLLINGER_BANDS: BollingerBandStrategy,
  SIMPLE_TREND: SimpleTrendStrategy,
  VOLUME_BREAKOUT: VolumeBreakoutStrategy,
  GRID_SCALPER: GridScalperStrategy,
  SIMPLE_PERCENT: SimplePercentStrategy,
  DYNAMIC_TRAILING: DynamicTrailingStrategy
};

const ACTIVE_STRATEGY_NAME = process.env.ACTIVE_STRATEGY || 'MEAN_REVERSION';
const configFilename = process.env.ACTIVE_STRATEGY_CONFIG || `${ACTIVE_STRATEGY_NAME}-default.json`;

let strategyConfig = {};
try {
  const configPath = path.join(__dirname, 'strategies', 'configs', configFilename);
  if (existsSync(configPath)) {
    const rawData = readFileSync(configPath, 'utf8');
    strategyConfig = JSON.parse(rawData);
    logger.info(`Loaded strategy configuration from ${configFilename}`);
  } else {
    logger.warn(`Config file ${configFilename} not found. using core defaults.`);
  }
} catch (err) {
  logger.error(`Error reading strategy config: ${err.message}`);
}

const StrategyClass = STRATEGIES[ACTIVE_STRATEGY_NAME] || MeanReversionStrategy;
const baseStrategy = new StrategyClass(strategyConfig);

// Wrap with Profit Guard if threshold is set
const activeStrategy = PROFIT_THRESHOLD > 0 
    ? new ProfitGuardedStrategy(baseStrategy, PROFIT_THRESHOLD)
    : baseStrategy;

const BOT_VERSION = "1.1.0";

logger.info(`Bot Version v${BOT_VERSION} Starting...`);
const strategyProfile = configFilename.replace(`${ACTIVE_STRATEGY_NAME}-`, '').replace('.json', '');
logger.info(`Strategy Loaded: ${activeStrategy.name} (v${activeStrategy.version}) [Profile: ${strategyProfile}]`);
logger.info(`Strategy Details: ${JSON.stringify(strategyConfig, null, 2)}`);
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
        state.gridLastHigh = state.gridLastHigh || null;
        
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
    const interval = process.env.BINANCE_INTERVAL || '1m';
    const apiUrl = `https://api.binance.us/api/v3/klines?symbol=SOLUSDT&interval=${interval}&limit=100`;
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
        gridLastHigh: null,
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
      // Restore GridScalper dip-tracking high so it survives restarts
      if (state.gridLastHigh && baseStrategy.lastHigh !== undefined) {
        baseStrategy.lastHigh = state.gridLastHigh;
        logger.info(`Restored grid lastHigh: $${state.gridLastHigh.toFixed(2)}`);
      }
      logger.info(`\n`);
    }

    // Startup Notification
    const startupMsg = `**Bot Initialized**\n**Strategy**: ${activeStrategy.name}\n**Profile**: ${strategyProfile}\n**Portfolio**: ${state.currentAmount.toFixed(4)} ${state.currentAsset}`;
    sendDiscordNotification(DISCORD_WEBHOOK_URL, startupMsg, 0x3498DB); // Blue for startup

    let { initialAsset, initialAmount } = state;
    let startToken = state.currentAsset;
    let targetToken = startToken === 'SOL' ? 'USDC' : 'SOL';
    let currentAmount = state.currentAmount;
    let reservedSol = state.reservedSol || 0;

    // Session tracking for hourly heartbeat
    const sessionStartTime = Date.now();
    let sessionTradeCount = 0;
    let lastHeartbeatTime = Date.now();

    if (!TOKENS[startToken] || !TOKENS[targetToken]) {
      throw new Error(`Invalid token. Supported tokens are SOL and USDC.`);
    }

    if (startToken === 'SOL') {
      logger.info(`Goal: Monitor the market to find the best time to swap your SOL to USDC.`);
      const macdSnippet = activeStrategy.config?.USE_MACD ? " AND MACD Histogram < 0" : "";
      const vwapSnippet = activeStrategy.config?.USE_VWAP ? " AND Price drops below VWAP" : "";
      if (activeStrategy.config?.SELL_RSI_THRESHOLD) {
         logger.info(`Condition Criteria: Wait for SOL to be OVERBOUGHT (RSI > ${activeStrategy.config.SELL_RSI_THRESHOLD})${macdSnippet}${vwapSnippet}.`);
      } else {
         logger.info(`Condition Criteria: Executing custom logic for ${activeStrategy.name}.`);
      }
    } else {
      logger.info(`Goal: Monitor the market to find the best time to swap your USDC to SOL.`);
      const macdSnippet = activeStrategy.config?.USE_MACD ? " AND MACD Histogram > 0" : "";
      const vwapSnippet = activeStrategy.config?.USE_VWAP ? " AND Price climbs above VWAP" : "";
      if (activeStrategy.config?.BUY_RSI_THRESHOLD) {
         logger.info(`Condition Criteria: Wait for SOL to be OVERSOLD (RSI < ${activeStrategy.config.BUY_RSI_THRESHOLD})${macdSnippet}${vwapSnippet}.`);
      } else {
         logger.info(`Condition Criteria: Executing custom logic for ${activeStrategy.name}.`);
      }
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

        // If starting fresh with SOL and no known cost basis, anchor entry price to
        // the current live price. This gives GridScalper (and similar strategies) a
        // reference point for sell targets and stop-losses from day one.
        if (state.currentAsset === 'SOL' && state.entryPrice === 0) {
          state.entryPrice = livePrice;
          state.updatedAt = new Date().toISOString();
          await this.saveState(state);
          logger.info(`[Session] No entry price found. Anchoring cost basis to current price: $${livePrice.toFixed(2)}`);
        }

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

        const solBalance = startToken === 'SOL' ? currentAmount : reservedSol;
        const usdcBalance = startToken === 'USDC' ? currentAmount : 0;

        const pnlStr = currentPnl >= 0 ? `+${currentPnl.toFixed(4)}` : `${currentPnl.toFixed(4)}`;
        const pnlPercStr = pnlPercentage >= 0 ? `+${pnlPercentage.toFixed(2)}%` : `${pnlPercentage.toFixed(2)}%`;

        const { triggered, type, metrics } = activeStrategy.checkSignal(indicators, livePrice, startToken, state.entryPrice);

        // Persist GridScalper's lastHigh so it survives restarts
        if (metrics.lastHigh) {
          state.gridLastHigh = metrics.lastHigh;
        } else if (startToken === 'SOL') {
          // Reset when we flip back to holding SOL (GridScalper resets lastHigh internally)
          state.gridLastHigh = null;
        }
        
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

        // Hourly Heartbeat — send a status update to Discord every HEARTBEAT_INTERVAL_MS
        if (Date.now() - lastHeartbeatTime >= HEARTBEAT_INTERVAL_MS) {
          lastHeartbeatTime = Date.now();
          
          const formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false });
          const currentHourPST = parseInt(formatter.format(new Date())) % 24;
          const isQuietHours = currentHourPST >= 22 || currentHourPST < 6;

          if (!isQuietHours) {
            const uptimeTotalMs = Date.now() - sessionStartTime;
            const uptimeHours = Math.floor(uptimeTotalMs / 3_600_000);
            const uptimeMins  = Math.floor((uptimeTotalMs % 3_600_000) / 60_000);
            const heartbeatMsg = [
              `**Bot Version:** v${BOT_VERSION}`,
              `**Strategy:** ${activeStrategy.name} (v${activeStrategy.version})`,
              `**Balances:** ${solBalance.toFixed(4)} SOL | ${usdcBalance.toFixed(2)} USDC`,
              `**Price:** $${livePrice.toFixed(2)}`,
              ``,
              `**Session PNL:** ${pnlPercStr} (${pnlStr} ${initialAsset})`,
              `**Mode:** ${strategyParts.join(' | ')}`,
              ``,
              `**Session Trades:** ${sessionTradeCount}`,
              `**Uptime:** ${uptimeHours}h ${uptimeMins}m`,
            ].join('\n');
            sendDiscordNotification(DISCORD_WEBHOOK_URL, heartbeatMsg, 0xFFA500, '💓 Hourly Heartbeat');
            logger.info(`[Heartbeat] Sent to Discord — Uptime: ${uptimeHours}h ${uptimeMins}m | Trades this session: ${sessionTradeCount}`);
          } else {
            logger.info(`[Heartbeat] Suppressed (Quiet Hours 10PM-6AM PST)`);
          }
        }

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
            const alarmParts = typeof activeStrategy.getAlarmParts === 'function' 
              ? activeStrategy.getAlarmParts(signalType, metrics, livePrice)
              : [ `Strategy ${activeStrategy.name} signaled ${signalType} at $${livePrice.toFixed(2)}` ];

            if (signalType === 'SELL') {
              logger.info(`\n🚨 SELL RECOMMENDATION ALARM 🚨`);
            } else {
              logger.info(`\n🚨 BUY RECOMMENDATION ALARM 🚨`);
            }
            
            alarmParts.forEach(part => logger.info(part));
          }
        }

        if (signalTriggered) {
          logger.info(`Execute your manual swap to ${targetToken} right now to secure a statistically higher win rate!`);
          logger.info(`\x07`);
          
          // Discord Notification
          const discordColor = signalType === 'BUY' ? 0x00FF00 : 0xFF0000;
          const discordTitle = signalType === 'BUY' ? "🟢 BUY RECOMMENDATION" : "🔴 SELL RECOMMENDATION";
          const discordMsg = `**Action**: ${signalType} SOL\n**Price**: $${livePrice.toFixed(2)}\n**Balances**: ${solBalance.toFixed(4)} SOL | ${usdcBalance.toFixed(2)} USDC\n**PNL**: ${pnlPercStr} (${currentPnl.toFixed(4)} ${initialAsset})\n**Bot Version**: v${BOT_VERSION}\n**Strategy**: ${activeStrategy.name} (v${activeStrategy.version})\n\n*Execute your swap to ${targetToken} now!*`;
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
          
          // BUG FIX: Use livePrice (clean 1-SOL spot quote) as the entry reference.
          // The old formula (tradeAmount/receiveAmount for BUY) used the full USDC balance
          // from the previous sell divided by SOL received after fees — this inflated the
          // cost basis above the current market price, causing the stop-loss to fire
          // almost immediately after every buy in a downtrend.
          // Using livePrice ensures stop-loss and profit-target are always relative to
          // the actual market price at the moment of entry, matching the configured %s.
          state.currentAsset = startToken;
          state.currentAmount = currentAmount;
          state.reservedSol = reservedSol;
          state.entryPrice = livePrice; // Anchor to current market price, not inflated cost basis
          state.gridLastHigh = null;    // Always reset lastHigh on a trade execution
          state.updatedAt = new Date().toISOString();
          sessionTradeCount++;
          await this.saveState(state);

          // Log to dedicated trade file (entry reference = livePrice at signal time)
          const tradeLogEntry = `${new Date().toISOString()},${signalType},${tradeAmount.toFixed(6)},${state.currentAsset === 'SOL' ? 'USDC' : 'SOL'},${receiveAmount.toFixed(6)},${state.currentAsset},${livePrice.toFixed(4)}`;
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
