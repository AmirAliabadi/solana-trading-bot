import { RSI, ATR, EMA } from 'technicalindicators';

/**
 * DYNAMIC_TRAILING Strategy v1.0.0
 *
 * A volatility-aware swing trading strategy for SOL/USDC that scales its
 * stop-loss and profit target dynamically based on the Average True Range (ATR).
 *
 * ENTRY (BUY) Logic:
 *   - Price makes a new local low (swing low confirmed)
 *   - RSI is simultaneously higher than on the previous swing low (bullish divergence)
 *   - RSI is below the oversold threshold (confirming a dip, not a peak)
 *   - ATR is not spiking above the panic threshold (avoids buying into crash)
 *
 * EXIT (SELL) Logic:
 *   - Stop-loss:    entryPrice - (ATR × stopMultiplier)  [default: 1.5x ATR]
 *   - Take-profit:  entryPrice + (ATR × profitMultiplier) [default: 2.5x ATR]
 *   - Trailing stop: ratchets upward as price climbs (locks in profits)
 *
 * Key benefit over fixed-% strategies: During high volatility (SOL flash crash),
 * ATR naturally widens the stop-loss buffer, preventing premature stop-outs.
 * During calm markets, ATR tightens — locking profits faster.
 */
export class DynamicTrailingStrategy {
    constructor(config = {}) {
        this.name = 'DYNAMIC_TRAILING';
        this.version = '1.0.0';
        this.config = config;

        // ATR configuration
        this.atrPeriod = parseInt(config.ATR_PERIOD) || 14;
        this.stopMultiplier = parseFloat(config.ATR_STOP_MULT) || 1.5;   // stop-loss = entry - (ATR × mult)
        this.profitMultiplier = parseFloat(config.ATR_PROFIT_MULT) || 2.5;   // take-profit = entry + (ATR × mult)
        this.trailMult = parseFloat(config.ATR_TRAIL_MULT) || 1.2;   // trailing stop distance

        // RSI configuration
        this.rsiPeriod = parseInt(config.RSI_PERIOD) || 14;
        this.rsiBuyMax = parseFloat(config.RSI_BUY_MAX) || 45;    // Only buy when RSI is below this (dip zone)
        this.rsiSellMin = parseFloat(config.RSI_SELL_MIN) || 65;    // Force sell if RSI climbs this high

        // ATR panic guard: if current ATR > avgATR * this multiple, skip buying (crash in progress)
        this.atrPanicMult = parseFloat(config.ATR_PANIC_MULT) || 2.5;

        // Window for detecting swing lows and RSI divergence
        this.swingWindow = parseInt(config.SWING_WINDOW) || 5;

        // Internal state (survives within a session, cleared between trades)
        this.trailingHigh = null;
        this.currentAtr = null;
        this.entryAtr = null;
    }

    calculateIndicators(marketData) {
        const minPeriod = Math.max(this.atrPeriod, this.rsiPeriod, this.swingWindow) + 5;
        if (marketData.close.length < minPeriod) {
            return { ready: false };
        }

        // ATR
        const atrResult = ATR.calculate({
            period: this.atrPeriod,
            high: marketData.high,
            low: marketData.low,
            close: marketData.close
        });

        // RSI
        const rsiResult = RSI.calculate({
            period: this.rsiPeriod,
            values: marketData.close
        });

        // Smoothed ATR average (to detect panic spikes vs. normal volatility)
        const atrSmaWindow = Math.min(20, atrResult.length);
        const avgAtr = atrResult.slice(-atrSmaWindow).reduce((a, b) => a + b, 0) / atrSmaWindow;

        const latestAtr = atrResult[atrResult.length - 1];
        const latestRsi = rsiResult[rsiResult.length - 1];
        const latestClose = marketData.close[marketData.close.length - 1];

        // Detect swing low within the lookback window
        const window = this.swingWindow;
        const recentClose = marketData.close.slice(-window);
        const recentRsi = rsiResult.slice(-window);

        // A "swing low" is identified when the current bar's close is the minimum
        // of the recent window AND RSI is above a prior RSI low (divergence)
        const minClose = Math.min(...recentClose);
        const isSwingLow = latestClose <= minClose;

        // Divergence: price at/near low, but RSI is higher than the lowest RSI in window
        const minRsiInWindow = Math.min(...recentRsi);
        const hasBullishDivergence = isSwingLow && (latestRsi > minRsiInWindow) && (latestRsi < this.rsiBuyMax);

        // Is volatility normal (not a panic)?
        const isNormalVolatility = latestAtr <= avgAtr * this.atrPanicMult;

        return {
            ready: true,
            latestClose,
            latestRsi,
            latestAtr,
            avgAtr,
            isSwingLow,
            hasBullishDivergence,
            isNormalVolatility,
            stopLossLevel: null, // computed in checkSignal
            takeProfitLevel: null  // computed in checkSignal
        };
    }

    checkSignal(indicators, currentPrice, currentAsset, entryPrice = null) {
        if (!indicators?.ready) {
            return { triggered: false, type: null, reason: 'NOT_READY', metrics: {} };
        }

        const { latestRsi, latestAtr, hasBullishDivergence, isNormalVolatility } = indicators;

        let triggered = false;
        let type = null;
        let reason = null;

        if (currentAsset === 'USDC') {
            // ── BUY PHASE ──────────────────────────────────────────────────────────
            // Reset trailing tracker
            this.trailingHigh = null;

            const buySignal =
                hasBullishDivergence &&   // RSI divergence confirmed
                isNormalVolatility;        // Not buying during a panic

            if (buySignal) {
                triggered = true;
                type = 'BUY';
                reason = 'RSI_DIVERGENCE';
                this.entryAtr = latestAtr; // Lock ATR for stop/profit calculations
            }

        } else if (currentAsset === 'SOL' && entryPrice) {
            // ── SELL PHASE ─────────────────────────────────────────────────────────
            const atr = this.entryAtr || latestAtr;

            const stopLevel = entryPrice - (atr * this.stopMultiplier);
            const profitLevel = entryPrice + (atr * this.profitMultiplier);

            // Update trailing high
            if (this.trailingHigh === null || currentPrice > this.trailingHigh) {
                this.trailingHigh = currentPrice;
            }
            const trailStopLevel = this.trailingHigh - (atr * this.trailMult);

            const hitStop = currentPrice <= stopLevel;
            const hitProfit = currentPrice >= profitLevel;
            const hitTrailStop = currentPrice <= trailStopLevel && this.trailingHigh > entryPrice * 1.005; // only trail after 0.5% gain
            const rsiOverbought = latestRsi >= this.rsiSellMin;

            if (hitStop || hitProfit || hitTrailStop || rsiOverbought) {
                triggered = true;
                type = 'SELL';
                reason = hitStop ? 'STOP_LOSS'
                    : hitProfit ? 'PROFIT_TARGET'
                        : hitTrailStop ? 'TRAIL_STOP'
                            : 'RSI_OVERBOUGHT';
            }

            indicators.stopLossLevel = stopLevel;
            indicators.takeProfitLevel = profitLevel;
            indicators.trailStopLevel = trailStopLevel;
        }

        return {
            triggered,
            type,
            reason,
            metrics: {
                rsi: indicators.latestRsi,
                atr: indicators.latestAtr,
                avgAtr: indicators.avgAtr,
                trailingHigh: this.trailingHigh,
                stopLossLevel: indicators.stopLossLevel,
                takeProfitLevel: indicators.takeProfitLevel,
                trailStopLevel: indicators.trailStopLevel,
                entryPrice
            }
        };
    }

    getLogParts(indicators, livePrice, metrics) {
        if (!indicators?.ready) {
            return ['Mode: INITIALIZING (warming up indicators...)'];
        }

        const { latestRsi, latestAtr, avgAtr, hasBullishDivergence, isNormalVolatility } = indicators;
        const rsiIcon = latestRsi < this.rsiBuyMax ? '🟢' : latestRsi > this.rsiSellMin ? '🔴' : '⚪';
        const atrRatio = (latestAtr / avgAtr).toFixed(2);
        const panicIcon = isNormalVolatility ? '🟢' : '🔴 PANIC';

        if (metrics.stopLossLevel) {
            // We're holding SOL — show the exit levels
            return [
                `RSI: ${latestRsi.toFixed(1)} ${rsiIcon}`,
                `ATR: ${latestAtr.toFixed(3)} (${atrRatio}x avg) ${panicIcon}`,
                `Stop: $${metrics.stopLossLevel.toFixed(2)} | Target: $${metrics.takeProfitLevel?.toFixed(2)}`,
                `Trail Stop: $${metrics.trailStopLevel?.toFixed(2)} (from $${metrics.trailingHigh?.toFixed(2)})`
            ];
        } else {
            // Hunting for entry
            const divIcon = hasBullishDivergence ? '🟢 DIVERGENCE' : '⏳ Watching...';
            return [
                `RSI: ${latestRsi.toFixed(1)} ${rsiIcon}`,
                `ATR: ${latestAtr.toFixed(3)} (${atrRatio}x avg) ${panicIcon}`,
                `Divergence: ${divIcon}`
            ];
        }
    }
}
