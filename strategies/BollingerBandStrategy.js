import { BollingerBands, RSI } from 'technicalindicators';

export class BollingerBandStrategy {
  constructor(config = {}) {
    this.name = "Bollinger Band Reversion";
    this.period = config.BB_PERIOD || 20;
    this.stdDev = config.BB_STDDEV || 2;
  }

  getRequiredIndicators() {
    return ['BB', 'RSI'];
  }

  calculateIndicators(marketData) {
    const bb = BollingerBands.calculate({
      period: this.period,
      values: marketData.close,
      stdDev: this.stdDev
    });
    
    const rsi = RSI.calculate({
      period: 14,
      values: marketData.close
    });

    return {
      latestBb: bb[bb.length - 1],
      latestRsi: rsi[rsi.length - 1]
    };
  }

  checkSignal(indicators, livePrice, currentAsset) {
    const { latestBb, latestRsi } = indicators;
    const isBuy = currentAsset === 'USDC';

    if (!latestBb) return { triggered: false, type: null, metrics: {} };

    // Bollinger Band Logic:
    // Buy when price hits Lower Band (and RSI < 45 for extra safety)
    // Sell when price hits Upper Band (and RSI > 55)
    
    let bbMet = isBuy ? (livePrice <= latestBb.lower) : (livePrice >= latestBb.upper);
    let rsiMet = isBuy ? (latestRsi < 45) : (latestRsi > 55);

    const triggered = bbMet && rsiMet;

    return {
      triggered,
      type: triggered ? (isBuy ? 'BUY' : 'SELL') : null,
      metrics: {
        rsiMet: { met: rsiMet, val: latestRsi },
        macdMet: { met: bbMet, val: livePrice - latestBb.middle }, // Map price dist from middle to MACD slot
        vwapMet: { met: true, val: latestBb.middle } // Use Middle Band (SMA) as the VWAP baseline
      }
    };
  }
}
