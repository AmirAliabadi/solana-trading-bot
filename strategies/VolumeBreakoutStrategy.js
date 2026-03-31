import { SMA, RSI } from 'technicalindicators';

export class VolumeBreakoutStrategy {
    constructor(config = {}) {
        this.name = "VOLUME_BREAKOUT";
        this.version = "1.0.0";
        this.volPeriod = parseInt(config.VOLUME_MA_PERIOD) || 20;
        this.volMultiplier = parseFloat(config.VOLUME_MULTIPLIER) || 3.0;
        this.buyRsi = parseInt(config.BUY_RSI) || 60; // Don't buy if already insanely overbought
        this.sellRsi = parseInt(config.SELL_RSI) || 70;
        
        // Track peak for a simple 3% trailing stop on the sell side to ride the momentum
        this.lastHigh = null;
        this.sellThreshold = 0.03; 
    }

    calculateIndicators(priceHistory) {
        if (priceHistory.close.length < this.volPeriod) {
            throw new Error(`Not enough data. Need at least ${this.volPeriod} periods.`);
        }

        const rsiArray = RSI.calculate({ period: 14, values: priceHistory.close });
        const volSmaArray = SMA.calculate({ period: this.volPeriod, values: priceHistory.volume });

        const latestRsi = rsiArray[rsiArray.length - 1];
        const latestVolSma = volSmaArray[volSmaArray.length - 1];
        const latestVolume = priceHistory.volume[priceHistory.volume.length - 1];

        // Ensure price is actually moving up
        const previousClose = priceHistory.close[priceHistory.close.length - 2];
        const latestClose = priceHistory.close[priceHistory.close.length - 1];
        const priceIncreased = latestClose > previousClose;

        return {
            rsi: latestRsi,
            volSma: latestVolSma,
            currentVolume: latestVolume,
            priceIncreased: priceIncreased
        };
    }

    checkSignal(indicators, currentPrice, currentAsset, entryPrice = null) {
        let triggered = false;
        let type = null;

        if (currentAsset === 'USDC') {
            // BUY Logic: Volume Breakout
            this.lastHigh = null; // Reset peak tracker

            const volBreakout = indicators.currentVolume > (indicators.volSma * this.volMultiplier);
            const validRsi = indicators.rsi < this.buyRsi;

            if (volBreakout && indicators.priceIncreased && validRsi) {
                triggered = true;
                type = 'BUY';
            }
        } else if (currentAsset === 'SOL') {
            // SELL Logic: Trailing Stop or Extremely Overbought
            if (this.lastHigh === null || currentPrice > this.lastHigh) {
                this.lastHigh = currentPrice;
            }

            const hitTrailingStop = currentPrice <= this.lastHigh * (1 - this.sellThreshold);
            const rsiOverbought = indicators.rsi >= this.sellRsi;

            if (hitTrailingStop || rsiOverbought) {
                triggered = true;
                type = 'SELL';
            }
        }

        return { triggered, type, metrics: { ...indicators, lastHigh: this.lastHigh } };
    }

    getLogParts(indicators, livePrice, metrics) {
        const volRatio = (indicators.currentVolume / indicators.volSma).toFixed(1);
        const rsiColor = indicators.rsi > this.sellRsi ? '🔴' : (indicators.rsi < this.buyRsi ? '🟢' : '⚪');
        
        let targetPart = '';
        if (metrics.lastHigh) {
            const dropReq = (metrics.lastHigh * (1 - this.sellThreshold)).toFixed(2);
            targetPart = `Trail Stop: $${dropReq}`;
        } else {
            targetPart = `Vol Ratio: ${volRatio}x (Need >${this.volMultiplier.toFixed(1)}x)`;
        }

        return [
            `RSI: ${indicators.rsi.toFixed(1).padStart(4, ' ')} ${rsiColor}`,
            `Vol(1m): ${indicators.currentVolume.toFixed(2)}`,
            targetPart
        ];
    }

    getAlarmParts(type, metrics, livePrice) {
        if (type === 'SELL') {
            const reason = metrics.reason || 'SELL';
            if (reason === 'RSI_OVERBOUGHT') {
                return [
                    `📈 RSI Overbought (${metrics.rsi?.toFixed(1)} ≥ ${this.sellRsi}) — momentum exhausted, exiting position`,
                    `Trailing stop was at $${(metrics.lastHigh * (1 - this.sellThreshold)).toFixed(2)}`
                ];
            }
            return [
                `📉 Trailing Stop triggered — price ($${livePrice.toFixed(2)}) dropped ${(this.sellThreshold * 100).toFixed(1)}% from peak $${(metrics.lastHigh || livePrice).toFixed(2)}`,
                `Locking in breakout gains`
            ];
        }
        const volRatio = ((metrics.currentVolume || 0) / (metrics.volSma || 1)).toFixed(1);
        return [
            `🚀 Volume Breakout — ${volRatio}x the 20-period average (threshold: ${this.volMultiplier}x)`,
            `RSI (${metrics.rsi?.toFixed(1)}) below ${this.buyRsi} — momentum is not yet overextended`,
            `Price is moving up on high conviction — entering breakout`
        ];
    }
}
