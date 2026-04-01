export class FibonacciStrategy {
    constructor(config = {}) {
        this.name = 'FIBONACCI';
        this.version = '1.0.0';
        this.config = config;

        this.lookbackPeriod = parseInt(config.LOOKBACK_PERIOD) || 50;
        this.fibBuyLevel = parseFloat(config.FIB_BUY_LEVEL) || 0.618;
        this.fibSellLevel = parseFloat(config.FIB_SELL_LEVEL) || 0.236;
        this.stopLossLevel = parseFloat(config.STOP_LOSS_LEVEL) || 1.0;
        this.requireBounce = config.REQUIRE_BOUNCE !== undefined ? config.REQUIRE_BOUNCE : true;
    }

    calculateIndicators(marketData) {
        if (marketData.close.length < this.lookbackPeriod) {
            return { ready: false };
        }

        const recentHighs = marketData.high.slice(-this.lookbackPeriod);
        const recentLows = marketData.low.slice(-this.lookbackPeriod);
        
        const highestHigh = Math.max(...recentHighs);
        const lowestLow = Math.min(...recentLows);
        const range = highestHigh - lowestLow;
        
        const latestClose = marketData.close[marketData.close.length - 1];
        const prevClose = marketData.close[marketData.close.length - 2];
        
        const buyTarget = highestHigh - (range * this.fibBuyLevel);
        const sellTarget = highestHigh - (range * this.fibSellLevel);
        const stopLossTarget = highestHigh - (range * this.stopLossLevel);

        const isBounce = latestClose > prevClose;

        return {
            ready: true,
            highestHigh,
            lowestLow,
            range,
            buyTarget,
            sellTarget,
            stopLossTarget,
            latestClose,
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
            // BUY Logic
            const hitBuyTarget = currentPrice <= indicators.buyTarget;
            const bounceConfirmed = this.requireBounce ? indicators.isBounce : true;
            
            if (indicators.range > 0 && hitBuyTarget && bounceConfirmed) {
                triggered = true;
                type = 'BUY';
                reason = `FIB_PULLBACK_${this.fibBuyLevel.toFixed(3)}`;
            }
        } else if (currentAsset === 'SOL' && entryPrice) {
            // SELL Logic
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
                entryPrice
            }
        };
    }

    getLogParts(indicators, livePrice, metrics) {
        if (!indicators?.ready) {
            return ['Mode: INITIALIZING (warming up indicators...)'];
        }

        const rangeStr = `Range: $${indicators.lowestLow.toFixed(2)} - $${indicators.highestHigh.toFixed(2)}`;
        
        if (metrics.entryPrice) {
            // Holding SOL
            return [
                rangeStr,
                `Target: $${metrics.sellTarget?.toFixed(2)}`,
                `Stop Loss: $${metrics.stopLossTarget?.toFixed(2)}`
            ];
        } else {
            // Holding USDC
            const bounceStr = this.requireBounce ? ` (Bounce: ${indicators.isBounce ? 'Yes' : 'No'})` : '';
            return [
                rangeStr,
                `Buy Trigger: $${metrics.buyTarget?.toFixed(2)}${bounceStr}`
            ];
        }
    }
}
