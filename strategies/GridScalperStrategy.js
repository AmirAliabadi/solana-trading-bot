export class GridScalperStrategy {
    constructor(config = {}) {
        this.name = "GRID_SCALPER";
        // Convert config values like 0.8 to absolute decimals like 0.008
        this.buyDropPct = (parseFloat(config.GRID_BUY_DROP_PCT) || 0.8) / 100;
        // Accept both key names for backwards compatibility
        this.sellTargetPct = (parseFloat(config.GRID_SELL_TARGET_PCT) || parseFloat(config.GRID_PROFIT_TARGET_PCT) || 1.0) / 100;
        this.stopLossPct = (parseFloat(config.GRID_STOP_LOSS_PCT) || 1.5) / 100;
        
        this.lastHigh = null;
    }

    calculateIndicators(priceHistory) {
         // This strategy requires no complex TA! Pure price action.
         return {};
    }

    checkSignal(indicators, currentPrice, currentAsset, entryPrice = null) {
        let triggered = false;
        let type = null;

        if (currentAsset === 'USDC') {
            // Track the local peak while sitting safely in stablecoins
            if (this.lastHigh === null || currentPrice > this.lastHigh) {
                this.lastHigh = currentPrice;
            }

            // BUY trigger: Price drops by our exact 'dip-hunting' percentage from the local high
            if (currentPrice <= this.lastHigh * (1 - this.buyDropPct)) {
                triggered = true;
                type = 'BUY';
            }
        } else if (currentAsset === 'SOL') {
            // We are holding SOL. We don't care about indicators, we only care about hitting our exact target ROI.
            this.lastHigh = null; // Reset the peak tracker for the next cycle

            if (entryPrice) {
                const hitProfitTarget = currentPrice >= entryPrice * (1 + this.sellTargetPct);
                const hitStopLoss = currentPrice <= entryPrice * (1 - this.stopLossPct);

                // SELL trigger: Price hits profit target OR stop-loss
                if (hitProfitTarget || hitStopLoss) {
                    triggered = true;
                    type = 'SELL';
                }
            }
        }

        const stopLossLevel = entryPrice ? entryPrice * (1 - this.stopLossPct) : null;
        return { 
            triggered, 
            type, 
            metrics: { lastHigh: this.lastHigh, entryPrice, stopLossLevel } 
        };
    }

    getLogParts(indicators, livePrice, metrics) {
        if (metrics.lastHigh) {
            const dropTarget = (metrics.lastHigh * (1 - this.buyDropPct)).toFixed(2);
            return [
                `Mode: 📉 HUNTING DIPS`,
                `Buy Trigger Level: $${dropTarget}`
            ];
        } else if (metrics.entryPrice) {
            const sellTarget = (metrics.entryPrice * (1 + this.sellTargetPct)).toFixed(2);
            const stopLevel = (metrics.entryPrice * (1 - this.stopLossPct)).toFixed(2);
            return [
                `Mode: 🎯 SCALPING TARGET`,
                `Target: $${sellTarget} | Stop: 🛑$${stopLevel}`
            ];
        }
        return ['Mode: INITIALIZING...'];
    }
}
