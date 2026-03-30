export class ProfitGuardedStrategy {
  constructor(baseStrategy, threshold = 0.025) {
    this.baseStrategy = baseStrategy;
    this.name = `${baseStrategy.name} + Profit Guard (${threshold}%)`;
    this.version = "1.0.0";
    this.threshold = threshold / 100; // Convert percentage to decimal
  }

  getRequiredIndicators() {
    return this.baseStrategy.getRequiredIndicators();
  }

  calculateIndicators(marketData) {
    return this.baseStrategy.calculateIndicators(marketData);
  }

  checkSignal(indicators, livePrice, currentAsset, entryPrice) {
    const signal = this.baseStrategy.checkSignal(indicators, livePrice, currentAsset, entryPrice);

    // If the base strategy doesn't want to trade, we don't either
    if (!signal.triggered) return signal;

    // Profit Guard Logic:
    // If we have an entryPrice (not 0), ensure the trade actually yields profit.
    if (entryPrice > 0) {
      // CRITICAL: Stop-loss exits MUST always be allowed through.
      // A stop-loss is an emergency exit at a loss by definition — blocking it
      // with a profit requirement defeats the entire purpose of the stop-loss.
      if (signal.reason === 'STOP_LOSS') {
        return {
          ...signal,
          metrics: {
            ...signal.metrics,
            profitGuard: { met: true, val: livePrice, target: entryPrice, note: 'BYPASSED (STOP-LOSS)' }
          }
        };
      }

      const isBuy = currentAsset === 'USDC'; // We are trying to buy SOL
      let profitMet = false;

      if (isBuy) {
        // We are holding USDC, trying to buy SOL.
        // We want the price to be LOWER than our previous sell price.
        profitMet = livePrice <= entryPrice * (1 - this.threshold);
      } else {
        // We are holding SOL, trying to sell for USDC.
        // We want the price to be HIGHER than our previous buy price.
        profitMet = livePrice >= entryPrice * (1 + this.threshold);
      }

      if (!profitMet) {
        // Block the trade because the profit target isn't met
        return {
          triggered: false,
          type: null,
          metrics: {
            ...signal.metrics,
            profitGuard: { met: false, val: livePrice, target: entryPrice }
          }
        };
      }
    }

    // Profit guard is satisfied or we have no history
    return {
      ...signal,
      metrics: {
        ...signal.metrics,
        profitGuard: { met: true, val: livePrice, target: entryPrice }
      }
    };
  }

  getLogParts(indicators, livePrice, metrics) {
    const parts = this.baseStrategy.getLogParts(indicators, livePrice, metrics);
    if (metrics.profitGuard && !metrics.profitGuard.met) {
      parts.push(`PROFIT: BLOCK 🛑`);
    } else if (metrics.profitGuard) {
      parts.push(`PROFIT: OK ✅`);
    }
    return parts;
  }
}
