export class GridScalperStrategy {
    constructor(config = {}) {
        this.name = "GRID_SCALPER";
        // Convert config values like 0.8 to absolute decimals like 0.008
        this.buyDropPct = (parseFloat(config.GRID_BUY_DROP_PCT) || 0.8) / 100;
        this.sellTargetPct = (parseFloat(config.GRID_SELL_TARGET_PCT) || 1.0) / 100;
        
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

            // SELL trigger: Price hits our hard profit target relative to when we bought
            if (entryPrice && currentPrice >= entryPrice * (1 + this.sellTargetPct)) {
                triggered = true;
                type = 'SELL';
            }
        }

        return { 
            triggered, 
            type, 
            metrics: { lastHigh: this.lastHigh, entryPrice } 
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
            return [
                `Mode: 🎯 SCALPING TARGET`,
                `Sell Target Level: $${sellTarget}`
            ];
        }
        return ['Mode: INITIALIZING...'];
    }
}
