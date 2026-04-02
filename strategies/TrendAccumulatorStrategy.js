import { MACD, RSI, EMA } from 'technicalindicators';

/**
 * TREND_ACCUMULATOR Strategy v1.0.0
 *
 * Designed to confidently ride the trend during bull markets while protecting
 * against significant downturns. It uses MACD for structural trend direction,
 * an EMA baseline for momentum, and RSI for timing entries/exits effectively.
 */
export class TrendAccumulatorStrategy {
    constructor(config = {}) {
        this.name = 'TREND_ACCUMULATOR';
        this.version = '1.0.0';
        this.config = config;

        // MACD config
        this.fastPeriod = parseInt(config.MACD_FAST) || 12;
        this.slowPeriod = parseInt(config.MACD_SLOW) || 26;
        this.signalPeriod = parseInt(config.MACD_SIGNAL) || 9;

        // EMA baseline config (for structural trend)
        this.emaPeriod = parseInt(config.EMA_PERIOD) || 50;

        // RSI config
        this.rsiPeriod = parseInt(config.RSI_PERIOD) || 14;
        this.rsiBuyMax = parseFloat(config.RSI_BUY_MAX) || 60; // Don't buy if it's overbought
        this.rsiSellMin = parseFloat(config.RSI_SELL_MIN) || 70; // Take profit when highly overbought

        // Trailing stop loss (to lock profits on massive runners)
        this.trailPct = (parseFloat(config.TRAIL_PCT) || 3.0) / 100;
        this.trailingHigh = null;
    }

    calculateIndicators(marketData) {
        const minPeriod = Math.max(this.slowPeriod + this.signalPeriod, this.emaPeriod, this.rsiPeriod) + 5;
        if (marketData.close.length < minPeriod) {
            return { ready: false };
        }

        const macdResult = MACD.calculate({
            values: marketData.close,
            fastPeriod: this.fastPeriod,
            slowPeriod: this.slowPeriod,
            signalPeriod: this.signalPeriod,
            SimpleMAOscillator: false,
            SimpleMASignal: false
        });

        const rsiResult = RSI.calculate({
            period: this.rsiPeriod,
            values: marketData.close
        });

        const emaResult = EMA.calculate({
            period: this.emaPeriod,
            values: marketData.close
        });

        const latestMacd = macdResult[macdResult.length - 1]; // format: { MACD, signal, histogram }
        const prevMacd = macdResult[macdResult.length - 2];
        const latestRsi = rsiResult[rsiResult.length - 1];
        const latestEma = emaResult[emaResult.length - 1];
        const latestClose = marketData.close[marketData.close.length - 1];

        // Is MACD crossing up? (Histogram turns positive)
        const macdCrossUp = prevMacd.histogram <= 0 && latestMacd.histogram > 0;
        // Is MACD crossing down? (Histogram turns negative)
        const macdCrossDown = prevMacd.histogram >= 0 && latestMacd.histogram < 0;

        const isAboveEma = latestClose > latestEma;

        return {
            ready: true,
            latestClose,
            latestRsi,
            latestMacd,
            latestEma,
            macdCrossUp,
            macdCrossDown,
            isAboveEma
        };
    }

    checkSignal(indicators, currentPrice, currentAsset, entryPrice = null) {
        if (!indicators?.ready) {
            return { triggered: false, type: null, reason: 'NOT_READY', metrics: {} };
        }

        const { latestRsi, latestMacd, latestEma, macdCrossUp, macdCrossDown, isAboveEma } = indicators;

        let triggered = false;
        let type = null;
        let reason = null;

        if (currentAsset === 'USDC') {
            this.trailingHigh = null; // Reset trailing high

            // Buy if price is above structural baseline, MACD confirms momentum, and we aren't completely overbought
            const structuralBuy = isAboveEma && latestMacd.histogram > 0 && latestRsi < this.rsiBuyMax;
            
            // Buy if a fresh bounce (cross up) happens even if below EMA (catching the absolute bottom reversal)
            const reversalBuy = macdCrossUp && latestRsi < this.rsiBuyMax;

            if (structuralBuy || reversalBuy) {
                triggered = true;
                type = 'BUY';
                reason = reversalBuy ? 'MACD_REVERSAL_BUY' : 'STRUCTURAL_BUY';
            }
        } else if (currentAsset === 'SOL' && entryPrice) {
            if (this.trailingHigh === null || currentPrice > this.trailingHigh) {
                this.trailingHigh = currentPrice;
            }

            const trailStopLevel = this.trailingHigh * (1 - this.trailPct);
            const hitTrailStop = currentPrice <= trailStopLevel && this.trailingHigh > entryPrice * 1.01; // Activate trial after 1% profit minimum

            // Emergency stop or trend death
            const trendDeath = macdCrossDown && !isAboveEma; 
            
            // Hard overbought sell
            const overbought = latestRsi >= this.rsiSellMin;

            // Failsafe stop
            const hardStop = currentPrice <= entryPrice * 0.95; // 5% absolute stop loss

            if (hitTrailStop || trendDeath || overbought || hardStop) {
                triggered = true;
                type = 'SELL';
                reason = hitTrailStop ? 'TRAIL_STOP' 
                        : trendDeath ? 'TREND_DEATH' 
                        : overbought ? 'RSI_OVERBOUGHT' 
                        : 'STOP_LOSS';
            }
        }

        return {
            triggered,
            type,
            reason,
            metrics: {
                rsi: latestRsi,
                macd: latestMacd.histogram,
                ema: latestEma,
                trailingHigh: this.trailingHigh,
                trailStopLevel: this.trailingHigh ? this.trailingHigh * (1 - this.trailPct) : null
            }
        };
    }

    getLogParts(indicators, livePrice, metrics) {
        if (!indicators?.ready) {
            return ['Mode: INITIALIZING...'];
        }

        const rsiIcon = metrics.rsi < this.rsiBuyMax ? '🟢' : metrics.rsi > this.rsiSellMin ? '🔴' : '⚪';
        const macdIcon = metrics.macd > 0 ? '🟢' : '🔴';
        const emaIcon = livePrice > metrics.ema ? '🟢' : '🔴';

        if (metrics.trailingHigh) {
            return [
                `RSI: ${metrics.rsi.toFixed(1)} ${rsiIcon}`,
                `MACD Hist: ${metrics.macd.toFixed(3)} ${macdIcon}`,
                `Trailing Stop: $${metrics.trailStopLevel?.toFixed(2)} (High $${metrics.trailingHigh?.toFixed(2)})`
            ];
        } else {
            return [
                `RSI: ${metrics.rsi.toFixed(1)} ${rsiIcon}`,
                `MACD Hist: ${metrics.macd.toFixed(3)} ${macdIcon}`,
                `EMA(50): $${metrics.ema.toFixed(2)} ${emaIcon}`
            ];
        }
    }
}
