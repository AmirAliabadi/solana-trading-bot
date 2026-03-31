export class SimplePercentStrategy {
    constructor(config = {}) {
        this.name = "SIMPLE_PERCENT";
        this.version = "1.0.0";
        // Fixed percentages as per the request: 2% up to sell, 2.5% drop to buy back
        this.sellTargetPct = (parseFloat(config.SIMPLE_PERCENT_SELL_UP) || 2.0) / 100;
        this.buyTargetPct = (parseFloat(config.SIMPLE_PERCENT_BUY_DROP) || 2.5) / 100;
    }

    calculateIndicators(priceHistory) {
        // Required for compatibility, but no actual TA indicators are calculated.
        return {};
    }

    checkSignal(indicators, currentPrice, currentAsset, entryPrice = null) {
        let triggered = false;
        let type = null;

        if (!entryPrice) {
            // We need a reference point to calculate percentage drops or increases!
            // The bot provides this automatically after the first loop or from saved state.
            return { triggered: false, type: null, metrics: { entryPrice: null } };
        }

        if (currentAsset === 'SOL') {
            // We hold SOL, wait for X% increase (default 2%) from entry price to swap to USDC
            if (currentPrice >= entryPrice * (1 + this.sellTargetPct)) {
                triggered = true;
                type = 'SELL';
            }
        } else if (currentAsset === 'USDC') {
            // We hold USDC, wait for X% drop (default 2.5%) from the price we sold at to buy back
            if (currentPrice <= entryPrice * (1 - this.buyTargetPct)) {
                triggered = true;
                type = 'BUY';
            }
        }

        return { triggered, type, metrics: { entryPrice } };
    }

    getLogParts(indicators, livePrice, metrics) {
        if (!metrics.entryPrice) {
            return ['Mode: INITIALIZING (Awaiting Entry Price)'];
        }
        
        const sellTarget = (metrics.entryPrice * (1 + this.sellTargetPct)).toFixed(2);
        const buyTarget = (metrics.entryPrice * (1 - this.buyTargetPct)).toFixed(2);
        
        return [
            `Reference Price: $${metrics.entryPrice.toFixed(2)}`,
            `Sell Target (Up 2%): $${sellTarget}`,
            `Buy Dip Target (Down 2.5%): $${buyTarget}`
        ];
    }

    getAlarmParts(type, metrics, livePrice) {
        const ref = metrics.entryPrice || livePrice;
        if (type === 'SELL') {
            return [
                `🎯 Take-Profit hit — price ($${livePrice.toFixed(2)}) rose +${(this.sellTargetPct * 100).toFixed(1)}% from entry $${ref.toFixed(2)}`,
                `Fixed profit target reached — swapping back to USDC`
            ];
        }
        return [
            `📉 Dip Target hit — price ($${livePrice.toFixed(2)}) fell -${(this.buyTargetPct * 100).toFixed(1)}% from reference $${ref.toFixed(2)}`,
            `Fixed re-entry threshold reached — swapping back to SOL`
        ];
    }
}
