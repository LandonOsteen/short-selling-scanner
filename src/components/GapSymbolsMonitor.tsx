import React, { useState, useEffect } from 'react';
import { GapScanner, GapStock } from '../services/GapScanner';
import { getScannerConfig } from '../config/scannerConfig';

interface GapSymbolsMonitorProps {
  gapScanner: GapScanner;
}

const GapSymbolsMonitor: React.FC<GapSymbolsMonitorProps> = ({ gapScanner }) => {
  const [gapStocks, setGapStocks] = useState<GapStock[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Get fresh config each time component renders to pick up changes
  const config = getScannerConfig();

  useEffect(() => {
    const fetchGapStocks = async () => {
      try {
        setIsLoading(true);
        setError(null);
        console.log('GapSymbolsMonitor: Fetching gap stocks with config:', {
          minGap: config.gapCriteria.minGapPercentage,
          minVolume: config.gapCriteria.minCumulativeVolume,
          priceRange: `${config.gapCriteria.minPrice}-${config.gapCriteria.maxPrice}`
        });

        // Update the scanner's configuration before scanning
        gapScanner.updateConfig(config);

        const stocks = await gapScanner.scanForGappers();
        console.log('GapSymbolsMonitor: Scanner returned', stocks.length, 'stocks:', stocks.map(s => `${s.symbol} (${s.gapPercent.toFixed(1)}%, ${(s.cumulativeVolume/1000).toFixed(0)}K vol)`));
        setGapStocks(stocks);
        setLastUpdate(new Date());
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch gap stocks');
        console.error('GapSymbolsMonitor: Error fetching gap stocks:', err);
      } finally {
        setIsLoading(false);
      }
    };

    // Initial load
    fetchGapStocks();

    // Set up periodic updates every 30 seconds
    const interval = setInterval(fetchGapStocks, 30000);

    return () => clearInterval(interval);
  }, [gapScanner]);

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  };

  const formatNumber = (num: number, decimals: number = 2) => {
    return num.toFixed(decimals);
  };

  const formatVolume = (volume: number) => {
    if (volume >= 1000000) {
      return `${(volume / 1000000).toFixed(1)}M`;
    } else if (volume >= 1000) {
      return `${(volume / 1000).toFixed(0)}K`;
    }
    return volume.toString();
  };

  const getGapColor = (gapPercent: number) => {
    if (gapPercent >= 20) return '#e63946'; // High gap - red
    if (gapPercent >= 15) return '#f4a261'; // Medium gap - orange
    if (gapPercent >= 10) return '#c9aa96'; // Standard gap - accent
    return '#7fb069'; // Lower gap - green
  };

  const getVolumeStatus = (volume: number) => {
    const minRequired = config.gapCriteria.minCumulativeVolume;
    const ratio = volume / minRequired;
    if (ratio >= 2) return { status: 'high', color: '#7fb069' };
    if (ratio >= 1.5) return { status: 'good', color: '#c9aa96' };
    if (ratio >= 1) return { status: 'min', color: '#f4a261' };
    return { status: 'low', color: '#e63946' };
  };

  if (error) {
    return (
      <div className="gap-symbols-monitor">
        <div className="monitor-header">
          <h2>GAP SYMBOLS MONITOR</h2>
          <div className="error-indicator">ERROR</div>
        </div>
        <div className="error-message">
          <span>{error}</span>
          <button
            onClick={() => window.location.reload()}
            className="retry-button"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="gap-symbols-monitor">
      <div className="monitor-header">
        <h2>GAP SYMBOLS MONITOR</h2>
        <div className="status-indicators">
          <div className="update-status">
            {isLoading ? (
              <span className="loading">UPDATING...</span>
            ) : (
              <span className="last-update">
                Last: {lastUpdate ? formatTime(lastUpdate) : 'Never'}
              </span>
            )}
          </div>
          <div className="symbol-count">
            <span className="count-label">TRACKING:</span>
            <span className="count-value">{gapStocks.length}</span>
          </div>
        </div>
      </div>

      <div className="symbols-container">
        {gapStocks.length === 0 ? (
          <div className="no-symbols">
            <div className="no-symbols-icon">-</div>
            <div className="no-symbols-text">
              {isLoading ? 'Loading gap stocks...' : 'No qualifying gap stocks found'}
            </div>
            <div className="criteria-info">
              Criteria: {config.gapCriteria.minGapPercentage}%+ gap, {formatVolume(config.gapCriteria.minCumulativeVolume)}+ volume, ${config.gapCriteria.minPrice}-${config.gapCriteria.maxPrice} price range
            </div>
            <div className="debug-info" style={{ marginTop: '8px', fontSize: '10px', color: '#666', fontFamily: 'var(--font-mono)' }}>
              Debug: Scanner returned {gapStocks.length} stocks
            </div>
          </div>
        ) : (
          <div className="symbols-grid">
            {gapStocks.map((stock) => {
              const volumeStatus = getVolumeStatus(stock.cumulativeVolume);

              return (
                <div key={stock.symbol} className="symbol-card">
                  <div className="symbol-header">
                    <div className="symbol-name">{stock.symbol}</div>
                    <div
                      className="gap-percentage"
                      style={{ color: getGapColor(stock.gapPercent) }}
                    >
                      +{formatNumber(stock.gapPercent, 1)}%
                    </div>
                  </div>

                  <div className="symbol-metrics">
                    <div className="metric-row">
                      <span className="metric-label">Price:</span>
                      <span className="metric-value">${formatNumber(stock.currentPrice)}</span>
                    </div>

                    <div className="metric-row">
                      <span className="metric-label">Volume:</span>
                      <span
                        className="metric-value volume-value"
                        style={{ color: volumeStatus.color }}
                      >
                        {formatVolume(stock.cumulativeVolume)}
                      </span>
                    </div>

                    <div className="metric-row">
                      <span className="metric-label">HOD:</span>
                      <span className="metric-value">${formatNumber(stock.hod)}</span>
                    </div>

                    <div className="metric-row">
                      <span className="metric-label">From Close:</span>
                      <span className="metric-value">${formatNumber(stock.previousClose)}</span>
                    </div>
                  </div>

                  <div className="volume-indicator">
                    <div className="volume-bar">
                      <div
                        className="volume-fill"
                        style={{
                          width: `${Math.min(100, (stock.cumulativeVolume / (config.gapCriteria.minCumulativeVolume * 2)) * 100)}%`,
                          backgroundColor: volumeStatus.color
                        }}
                      />
                    </div>
                    <span className="volume-status">{volumeStatus.status.toUpperCase()}</span>
                  </div>

                  <div className="last-updated">
                    Updated: {new Date(stock.lastUpdated).toLocaleTimeString('en-US', {
                      hour12: false,
                      hour: '2-digit',
                      minute: '2-digit'
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="monitor-footer">
        <div className="refresh-info">
          <span>Auto-refresh every 30 seconds</span>
        </div>
        <div className="criteria-summary">
          Min Gap: {config.gapCriteria.minGapPercentage}% | Min Volume: {formatVolume(config.gapCriteria.minCumulativeVolume)} | Price: ${config.gapCriteria.minPrice}-${config.gapCriteria.maxPrice}
        </div>
      </div>
    </div>
  );
};

export default GapSymbolsMonitor;