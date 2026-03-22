import { RSI, MACD, VWAP } from 'technicalindicators';

export class MeanReversionStrategy {
  constructor(config = {}) {
    this.name = "Mean Reversion (RSI + MACD + VWAP)";
    this.buyRsi = config.BUY_RSI || 40;
    this.sellRsi = config.SELL_RSI || 60;
    this.useMacd = config.USE_MACD !== false;
    this.useVwap = config.USE_VWAP !== false;
    this.vwapOffset = config.VWAP_OFFSET || 0;
    this.macdFast = config.MACD_FAST || 12;
    this.macdSlow = config.MACD_SLOW || 26;
    this.macdSignal = config.MACD_SIGNAL || 9;
  }

  getRequiredIndicators() {
    return ['RSI', 'MACD', 'VWAP'];
  }

  calculateIndicators(marketData) {
    const rsiInput = { values: marketData.close, period: 14 };
    const rsiResult = RSI.calculate(rsiInput);

    const macdInput = {
      values: marketData.close,
      fastPeriod: this.macdFast,
      slowPeriod: this.macdSlow,
      signalPeriod: this.macdSignal,
      SimpleMAOscillator: false,
      SimpleMASignal: false
    };
    const macdResult = MACD.calculate(macdInput);

    const vwapInput = {
      high: marketData.high,
      low: marketData.low,
      close: marketData.close,
      volume: marketData.volume
    };
    const vwapResult = VWAP.calculate(vwapInput);

    return {
      latestRsi: rsiResult[rsiResult.length - 1],
      latestMacd: macdResult[macdResult.length - 1],
      latestVwap: vwapResult[vwapResult.length - 1]
    };
  }

  checkSignal(indicators, livePrice, currentAsset) {
    const { latestRsi, latestMacd, latestVwap } = indicators;
    const isBuy = currentAsset === 'USDC';
    
    let rsiMet = isBuy ? (latestRsi < this.buyRsi) : (latestRsi > this.sellRsi);
    let macdMet = isBuy ? (this.useMacd ? latestMacd.histogram > 0 : true) : (this.useMacd ? latestMacd.histogram < 0 : true);
    
    let vwapMet = true;
    if (this.useVwap) {
      const vwapThreshold = isBuy 
        ? latestVwap * (1 - (this.vwapOffset / 100))
        : latestVwap * (1 + (this.vwapOffset / 100));
      vwapMet = isBuy ? (livePrice > vwapThreshold) : (livePrice < vwapThreshold);
    }

    const triggered = rsiMet && macdMet && vwapMet;

    return {
      triggered,
      type: triggered ? (isBuy ? 'BUY' : 'SELL') : null,
      metrics: {
        rsiMet: { met: rsiMet, val: latestRsi },
        macdMet: { met: macdMet, val: latestMacd.histogram },
        vwapMet: { met: vwapMet, val: latestVwap }
      }
    };
  }

  getLogParts(indicators, livePrice, metrics) {
    const { latestRsi, latestMacd, latestVwap } = indicators;
    const { rsiMet, macdMet, vwapMet } = metrics;

    const rsiIcon = rsiMet.met ? '🟢' : '🔴';
    const macdIcon = this.useMacd ? (macdMet.met ? '🟢' : '🔴') : '⚪';
    const vwapIcon = this.useVwap ? (vwapMet.met ? '🟢' : '🔴') : '⚪';

    const rsiStr = latestRsi.toFixed(1).padStart(4, ' ');
    const macdStr = latestMacd.histogram.toFixed(3).padStart(6, ' ');
    const priceStr = livePrice.toFixed(2).padStart(6, ' ');
    const vwapStr = latestVwap.toFixed(2).padStart(6, ' ');

    return [
      `Price: $${priceStr}`,
      `VWAP: $${vwapStr} ${vwapIcon}`,
      `RSI: ${rsiStr} ${rsiIcon}`,
      `MACD: ${macdStr} ${macdIcon}`
    ];
  }
}
