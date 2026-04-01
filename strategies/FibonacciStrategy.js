import { RSI, EMA } from 'technicalindicators';

/**
 * Fibonacci Pullback Strategy
 * 
 * Accurately identifies recent price swings and calculates Fibonacci retracement levels.
 * Signals BUY on pullbacks to key levels (e.g. 0.618) with price action confirmation (bounces).
 * Signals SELL on recovery to targets or when stop-loss is hit.
 */
export class FibonacciStrategy {
    constructor(config = {}) {
        this.name = 'FIBONACCI';
        this.version = '1.2.0';
        this.config = config;

        // Configuration
        this.lookbackPeriod = parseInt(config.LOOKBACK_PERIOD) || 50;
        this.fibBuyLevel = parseFloat(config.FIB_BUY_LEVEL) || 0.618;
        this.fibSellLevel = parseFloat(config.FIB_SELL_LEVEL) || 0.382;
        this.stopLossLevel = parseFloat(config.STOP_LOSS_LEVEL) || 1.0;
        this.requireBounce = config.REQUIRE_BOUNCE !== undefined ? config.REQUIRE_BOUNCE : true;
        
        // Advanced Filters
        this.useRsiFilter = config.USE_RSI_FILTER !== false;
        this.buyRsiThreshold = parseFloat(config.BUY_RSI_THRESHOLD) || 45;
        this.emaConfirmPeriod = parseInt(config.EMA_CONFIRM_PERIOD) || 5;
    }

    calculateIndicators(marketData) {
        if (marketData.close.length < Math.max(this.lookbackPeriod, 14)) {
            return { ready: false };
        }

        const highs = marketData.high.slice(-this.lookbackPeriod);
        const lows = marketData.low.slice(-this.lookbackPeriod);
        const closes = marketData.close;
        
        // 1. Identify the most significant High and Low in the window
        let highestHigh = -Infinity;
        let highestHighIdx = -1;
        let lowestLow = Infinity;
        let lowestLowIdx = -1;

        for (let i = 0; i < highs.length; i++) {
            if (highs[i] > highestHigh) {
                highestHigh = highs[i];
                highestHighIdx = i;
            }
            if (lows[i] < lowestLow) {
                lowestLow = lows[i];
                lowestLowIdx = i;
            }
        }

        // 2. Determine Swing Context
        // For a BUY Pullback, we ideally want to see an uptrend impulse (Low occurred before High)
        const isUptrendSwing = lowestLowIdx < highestHighIdx;
        const range = highestHigh - lowestLow;
        
        // 3. Calculate Fibonacci Targets
        const buyTarget = highestHigh - (range * this.fibBuyLevel);
        const sellTarget = highestHigh - (range * this.fibSellLevel);
        const stopLossTarget = highestHigh - (range * this.stopLossLevel);

        // 4. Confirmation Indicators (EMA & RSI)
        const emaInput = { values: closes, period: this.emaConfirmPeriod };
        const emaValues = EMA.calculate(emaInput);
        const latestEma = emaValues[emaValues.length - 1];

        const rsiInput = { values: closes, period: 14 };
        const rsiValues = RSI.calculate(rsiInput);
        const latestRsi = rsiValues[rsiValues.length - 1];

        const latestClose = closes[closes.length - 1];
        const prevClose = closes[closes.length - 2];

        // Bounce Logic: Price crossed above EMA or significant green candle
        const priceAboveEma = latestClose > latestEma;
        const higherClose = latestClose > prevClose;
        const isBounce = priceAboveEma || higherClose;

        return {
            ready: true,
            highestHigh,
            lowestLow,
            lowestLowIdx,
            highestHighIdx,
            isUptrendSwing,
            range,
            buyTarget,
            sellTarget,
            stopLossTarget,
            latestClose,
            latestRsi,
            latestEma,
            isBounce
        };
    }

    checkSignal(indicators, currentPrice, currentAsset, entryPrice = null) {
        if (!indicators?.ready) {
            return { triggered: false, type: null, reason: 'NOT_READY', metrics: {} };
        }

        let triggered = false;
        let type = null;
        let reason = null;

        if (currentAsset === 'USDC') {
            // BUY Logic: Price in Pullback Zone + Confirmation
            const hitBuyTarget = currentPrice <= indicators.buyTarget;
            const bounceConfirmed = this.requireBounce ? indicators.isBounce : true;
            const rsiConfirmed = this.useRsiFilter ? (indicators.latestRsi < this.buyRsiThreshold) : true;
            
            // We only buy pullbacks of a visible uptrend sweep to avoid "catching falling knives" in pure downtrends
            const validSwing = indicators.range > 0 && indicators.isUptrendSwing;

            if (validSwing && hitBuyTarget && bounceConfirmed && rsiConfirmed) {
                triggered = true;
                type = 'BUY';
                reason = `FIB_PULLBACK_${this.fibBuyLevel.toFixed(3)}`;
            }
        } else if (currentAsset === 'SOL' && entryPrice) {
            // SELL Logic: Target Reached or Stop Loss Hit
            const hitSellTarget = currentPrice >= indicators.sellTarget;
            const hitStopLoss = currentPrice <= indicators.stopLossTarget;
            
            if (indicators.range > 0) {
                if (hitStopLoss) {
                    triggered = true;
                    type = 'SELL';
                    reason = `FIB_STOP_LOSS_${this.stopLossLevel.toFixed(3)}`;
                } else if (hitSellTarget) {
                    triggered = true;
                    type = 'SELL';
                    reason = `FIB_RECOVERY_${this.fibSellLevel.toFixed(3)}`;
                }
            }
        }

        return {
            triggered,
            type,
            reason,
            metrics: {
                buyTarget: indicators.buyTarget,
                sellTarget: indicators.sellTarget,
                stopLossTarget: indicators.stopLossTarget,
                highestHigh: indicators.highestHigh,
                lowestLow: indicators.lowestLow,
                latestRsi: indicators.latestRsi,
                isUptrendSwing: indicators.isUptrendSwing,
                entryPrice
            }
        };
    }

    getLogParts(indicators, livePrice, metrics) {
        if (!indicators?.ready) {
            return ['Mode: INITIALIZING (warming up indicators...)'];
        }

        const rangeStr = `Range: $${indicators.lowestLow.toFixed(2)} -> $${indicators.highestHigh.toFixed(2)}`;
        const swingStatus = indicators.isUptrendSwing ? '📈 Impulse' : '📉 Crash';
        const rsiStr = `RSI: ${indicators.latestRsi.toFixed(1)}`;
        
        if (metrics.entryPrice) {
            const targetDist = ((indicators.sellTarget - livePrice) / livePrice * 100).toFixed(2);
            return [
                rangeStr,
                `Target: $${indicators.sellTarget.toFixed(2)} (${targetDist}%)`,
                `Stop: $${indicators.stopLossTarget.toFixed(2)}`
            ];
        } else {
            const bounceStr = this.requireBounce ? ` (Bounce: ${indicators.isBounce ? '✅' : '❌'})` : '';
            const rsiOk = this.useRsiFilter ? (indicators.latestRsi < this.buyRsiThreshold ? '✅' : '❌') : '';
            return [
                `${swingStatus} | ${rangeStr}`,
                `Buy Trigger: $${indicators.buyTarget.toFixed(2)}${bounceStr}`,
                `RSI Filter: ${indicators.latestRsi.toFixed(1)} ${rsiOk}`
            ];
        }
    }
}
