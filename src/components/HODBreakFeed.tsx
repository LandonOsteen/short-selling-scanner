import React, { useEffect, useRef, useMemo, useState, useCallback } from 'react';
import './HODBreakFeed.css';
import { Alert } from '../types';
import { soundService } from '../services/SoundService';

interface HODBreakFeedProps {
  alerts: Alert[];
  voiceAlertsEnabled: boolean;
  soundAlertsEnabled: boolean;
  selectedSound: string;
  isConnected?: boolean;
  stats?: {
    totalAlerts: number;
    symbolsTracked: number;
    lastUpdate: string;
  };
  symbols?: string[];
}

const HODBreakFeed: React.FC<HODBreakFeedProps> = ({
  alerts,
  voiceAlertsEnabled,
  soundAlertsEnabled,
  selectedSound,
  isConnected = false,
  stats,
  symbols = []
}) => {
  const [sortBy, setSortBy] = useState<'time' | 'price' | 'volume' | 'gap'>('time');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [symbolFilter, setSymbolFilter] = useState('');
  const [priceRange, setPriceRange] = useState({ min: '', max: '' });
  const [showFilters, setShowFilters] = useState(false);
  const [patternFilter, setPatternFilter] = useState<'all' | 'ToppingTail5m' | 'GreenRunReject' | 'TestSignal'>('all');
  const [showSymbols, setShowSymbols] = useState(false);
  const prevAlertsLength = useRef(0);
  const prevAlertIds = useRef(new Set<string>());

  // Filter and deduplicate all pattern types
  const filteredAlerts = useMemo(() => {
    // Filter by pattern type if not 'all'
    const patternFiltered = patternFilter === 'all'
      ? alerts
      : alerts.filter(alert => alert.type === patternFilter);

    // Deduplicate by alert ID and also by symbol+timestamp+price combination
    const uniqueAlerts = new Map<string, Alert>();
    const seenCombinations = new Set<string>();

    patternFiltered.forEach(alert => {
      const combinationKey = `${alert.symbol}-${alert.timestamp}-${alert.price.toFixed(2)}-${alert.type}`;

      if (!uniqueAlerts.has(alert.id) && !seenCombinations.has(combinationKey)) {
        uniqueAlerts.set(alert.id, alert);
        seenCombinations.add(combinationKey);
      } else {
        console.log(`🔄 Filtered duplicate: ${alert.symbol} ${alert.type} ID: ${alert.id} Key: ${combinationKey}`);
      }
    });

    return Array.from(uniqueAlerts.values());
  }, [alerts, patternFilter]);

  // Apply filters and sorting
  const filteredAndSortedAlerts = useMemo(() => {
    let filtered = filteredAlerts.filter(alert => {
      // Symbol filter
      if (symbolFilter && !alert.symbol.toLowerCase().includes(symbolFilter.toLowerCase())) {
        return false;
      }

      // Price range filter
      if (priceRange.min && alert.price < parseFloat(priceRange.min)) {
        return false;
      }
      if (priceRange.max && alert.price > parseFloat(priceRange.max)) {
        return false;
      }

      return true;
    });

    // Sort alerts
    return filtered.sort((a, b) => {
      let comparison = 0;

      switch (sortBy) {
        case 'time':
          comparison = a.timestamp - b.timestamp;
          break;
        case 'price':
          comparison = a.price - b.price;
          break;
        case 'volume':
          comparison = a.volume - b.volume;
          break;
        case 'gap':
          comparison = (a.gapPercent || 0) - (b.gapPercent || 0);
          break;
      }

      return sortOrder === 'desc' ? -comparison : comparison;
    });
  }, [filteredAlerts, symbolFilter, priceRange, sortBy, sortOrder]);

  // Helper to get pattern display name
  const getPatternDisplayName = (type: string) => {
    switch (type) {
      case 'HODBreakCloseUnder':
        return 'HOD Break and Close Under';
      case 'ToppingTail1m':
        return '1-Minute Topping Tail';
      case 'ToppingTail5m':
        return '5-Minute Topping Tail';
      case 'GreenRunReject':
        return 'Green Run Rejection';
      case 'TestSignal':
        return 'Test Signal';
      default:
        return type;
    }
  };

  // Sound and voice alerts for new signals
  useEffect(() => {
    const newAlertCount = filteredAlerts.length;

    // Detect NEW alerts by ID, not just by count (handles max limit case)
    const currentIds = new Set(filteredAlerts.map(a => a.id));
    const newAlerts = filteredAlerts.filter(alert => !prevAlertIds.current.has(alert.id));

    if (newAlerts.length > 0) {
      newAlerts.forEach(async (newAlert) => {
        // Play sound alert immediately if enabled
        if (soundAlertsEnabled && selectedSound !== 'none') {
          try {
            await soundService.playSound(selectedSound);
          } catch (error) {
            console.error('Sound alert failed:', error);
          }
        }

        // Play voice alert if enabled
        if (voiceAlertsEnabled && 'speechSynthesis' in window) {
          const patternName = getPatternDisplayName(newAlert.type);
          const utterance = new SpeechSynthesisUtterance(`${patternName} signal for ${newAlert.symbol} at ${newAlert.price.toFixed(2)}`);
          utterance.rate = 1.2;
          utterance.pitch = 1.0;
          utterance.volume = 0.8;
          window.speechSynthesis.speak(utterance);
        }

        // Browser notification
        if ('Notification' in window && Notification.permission === 'granted') {
          const patternName = getPatternDisplayName(newAlert.type);
          new Notification(`${patternName} - ${newAlert.symbol}`, {
            body: `${newAlert.symbol}: $${newAlert.price.toFixed(2)} - ${newAlert.detail}`,
            icon: '/icon.png',
            badge: '/icon.png',
            tag: `${newAlert.type}-${newAlert.symbol}`,
            requireInteraction: true,
            silent: false
          });
        }
      });

      // Update the previous IDs set
      prevAlertIds.current = currentIds;
    }
    prevAlertsLength.current = newAlertCount;
  }, [filteredAlerts, voiceAlertsEnabled, soundAlertsEnabled, selectedSound]);

  const clearFilters = useCallback(() => {
    setSymbolFilter('');
    setPriceRange({ min: '', max: '' });
    setPatternFilter('all');
  }, []);

  // Helper to get pattern badge class
  const getPatternBadgeClass = (type: string) => {
    switch (type) {
      case 'HODBreakCloseUnder':
        return 'pattern-badge-hod';
      case 'ToppingTail1m':
        return 'pattern-badge-1m';
      case 'ToppingTail5m':
        return 'pattern-badge-5m';
      case 'GreenRunReject':
        return 'pattern-badge-green';
      case 'TestSignal':
        return 'pattern-badge-test';
      default:
        return 'pattern-badge';
    }
  };

  // Helper to get pattern badge text
  const getPatternBadgeText = (type: string) => {
    switch (type) {
      case 'HODBreakCloseUnder':
        return 'HOD BREAK';
      case 'ToppingTail1m':
        return 'TOPPING TAIL 1M';
      case 'ToppingTail5m':
        return 'TOPPING TAIL 5M';
      case 'GreenRunReject':
        return 'GREEN RUN REJECT';
      case 'TestSignal':
        return 'TEST SIGNAL';
      default:
        return type;
    }
  };

  const formatTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  };

  const getTimeSinceAlert = (timestamp: number) => {
    const now = Date.now();
    const diff = Math.floor((now - timestamp) / 1000);
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    return `${Math.floor(diff / 3600)}h ago`;
  };

  const requestNotificationPermission = useCallback(async () => {
    if ('Notification' in window && Notification.permission === 'default') {
      await Notification.requestPermission();
    }
  }, []);

  // Calculate performance metrics
  const performanceMetrics = useMemo(() => {
    const totalVolume = filteredAndSortedAlerts.reduce((sum, alert) => sum + alert.volume, 0);
    const avgPrice = filteredAndSortedAlerts.length > 0
      ? filteredAndSortedAlerts.reduce((sum, alert) => sum + alert.price, 0) / filteredAndSortedAlerts.length
      : 0;
    const avgGap = filteredAndSortedAlerts.length > 0
      ? filteredAndSortedAlerts.reduce((sum, alert) => sum + (alert.gapPercent || 0), 0) / filteredAndSortedAlerts.length
      : 0;
    const recentCount = filteredAndSortedAlerts.filter(alert => Date.now() - alert.timestamp < 300000).length; // Last 5 minutes

    return {
      totalVolume: Math.round(totalVolume / 1000), // In thousands
      avgPrice: avgPrice,
      avgGap: avgGap,
      recentCount
    };
  }, [filteredAndSortedAlerts]);

  return (
    <div className="hod-break-feed">
      <div className="hod-header">
        <div className="hod-title-section">
          <div className="hod-main-title">
            <span className="hod-title-text">SHORT SIGNALS</span>
            <span className="hod-subtitle">Premium Pattern Detection</span>
          </div>
          <div className="hod-metrics">
            <div className="metric-card">
              <span className="metric-value">{filteredAndSortedAlerts.length}</span>
              <span className="metric-label">Signals</span>
            </div>
            <div className="metric-card">
              <span className="metric-value">{performanceMetrics.recentCount}</span>
              <span className="metric-label">Recent</span>
            </div>
            <div className="metric-card">
              <span className="metric-value">${performanceMetrics.avgPrice.toFixed(2)}</span>
              <span className="metric-label">Avg Price</span>
            </div>
            <div className="metric-card">
              <span className="metric-value">{performanceMetrics.avgGap.toFixed(1)}%</span>
              <span className="metric-label">Avg Gap</span>
            </div>
          </div>
        </div>

        <div className="hod-controls">
          <div className="sort-controls">
            <label>Sort by:</label>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as any)}
              className="sort-select"
            >
              <option value="time">Time</option>
              <option value="price">Price</option>
              <option value="volume">Volume</option>
              <option value="gap">Gap %</option>
            </select>
            <button
              className={`sort-order-btn ${sortOrder}`}
              onClick={() => setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc')}
              title={`Sort ${sortOrder === 'asc' ? 'descending' : 'ascending'}`}
            >
              {sortOrder === 'asc' ? '↑' : '↓'}
            </button>
          </div>

          <button
            className={`filter-toggle ${showFilters ? 'active' : ''}`}
            onClick={() => setShowFilters(!showFilters)}
          >
            FILTERS
          </button>

          <button
            className={`symbols-toggle ${showSymbols ? 'active' : ''}`}
            onClick={() => setShowSymbols(!showSymbols)}
            title="Show monitored symbols"
          >
            SYMBOLS ({symbols.length})
          </button>

          {Notification.permission === 'default' && (
            <button
              className="notification-btn"
              onClick={requestNotificationPermission}
              title="Enable Browser Notifications"
            >
              NOTIFY
            </button>
          )}
        </div>
      </div>

      {showFilters && (
        <div className="hod-filter-panel">
          <div className="filter-grid">
            <div className="filter-group">
              <label>Pattern Type:</label>
              <select
                value={patternFilter}
                onChange={(e) => setPatternFilter(e.target.value as any)}
                className="filter-input"
              >
                <option value="all">All Patterns</option>
                <option value="ToppingTail5m">5m Topping Tail</option>
                <option value="GreenRunReject">Green Run Rejection</option>
                <option value="TestSignal">Test Signal</option>
              </select>
            </div>
            <div className="filter-group">
              <label>Symbol:</label>
              <input
                type="text"
                value={symbolFilter}
                onChange={(e) => setSymbolFilter(e.target.value)}
                placeholder="Filter symbols..."
                className="filter-input"
              />
            </div>
            <div className="filter-group">
              <label>Price Range:</label>
              <div className="range-inputs">
                <input
                  type="number"
                  value={priceRange.min}
                  onChange={(e) => setPriceRange(prev => ({ ...prev, min: e.target.value }))}
                  placeholder="Min"
                  className="filter-input range-input"
                  min="0"
                  step="0.01"
                />
                <span>-</span>
                <input
                  type="number"
                  value={priceRange.max}
                  onChange={(e) => setPriceRange(prev => ({ ...prev, max: e.target.value }))}
                  placeholder="Max"
                  className="filter-input range-input"
                  min="0"
                  step="0.01"
                />
              </div>
            </div>
            <button onClick={clearFilters} className="clear-filters">
              CLEAR
            </button>
          </div>
        </div>
      )}

      {showSymbols && (
        <div className="symbols-panel">
          <div className="symbols-panel-header">
            <h4>Monitored Symbols ({symbols.length})</h4>
            <span className="symbols-panel-subtitle">
              Currently scanning for 5m patterns
            </span>
          </div>
          <div className="symbols-grid">
            {symbols.length === 0 ? (
              <div className="no-symbols">No symbols currently being monitored</div>
            ) : (
              symbols.map((symbol) => (
                <div key={symbol} className="symbol-chip">
                  {symbol}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      <div className="hod-alerts-container">
        {filteredAndSortedAlerts.length === 0 ? (
          <div className="hod-no-alerts">
            <div className="no-alerts-main">
              {filteredAlerts.length === 0 ? 'AWAITING SHORT SIGNALS' : 'NO MATCHING SIGNALS'}
            </div>
            <div className="no-alerts-sub">
              {filteredAlerts.length === 0
                ? 'Monitoring for HOD breaks and topping tail patterns'
                : 'Try adjusting your filters to see more results'
              }
            </div>
          </div>
        ) : (
          filteredAndSortedAlerts.map((alert, index) => {
            const isRecent = Date.now() - alert.timestamp < 60000;
            const isTopPriority = index < 3;

            return (
              <div
                key={alert.id}
                className={`hod-alert-card ${isRecent ? 'recent' : ''} ${isTopPriority ? 'priority' : ''}`}
              >
                <div className="alert-card-header">
                  <div className="symbol-section">
                    <span className="symbol">{alert.symbol}</span>
                    <span className={`pattern-badge ${getPatternBadgeClass(alert.type)}`}>
                      {getPatternBadgeText(alert.type)}
                    </span>
                  </div>
                  <div className="price-section">
                    <span className="price">${alert.price.toFixed(2)}</span>
                    {alert.gapPercent !== undefined && (
                      <span className={`gap ${alert.gapPercent > 0 ? 'positive' : 'negative'}`}>
                        {alert.gapPercent > 0 ? '+' : ''}{alert.gapPercent.toFixed(1)}%
                      </span>
                    )}
                  </div>
                </div>

                <div className="alert-card-body">
                  <div className="signal-description">
                    {alert.detail}
                  </div>
                  <div className="alert-metrics">
                    <div className="metric">
                      <span className="metric-label">Volume:</span>
                      <span className="metric-value">{(alert.volume / 1000).toFixed(0)}K</span>
                    </div>
                    <div className="metric">
                      <span className="metric-label">Time:</span>
                      <span className="metric-value">{formatTime(alert.timestamp)}</span>
                    </div>
                    <div className="metric">
                      <span className="metric-label">Since:</span>
                      <span className="metric-value">{getTimeSinceAlert(alert.timestamp)}</span>
                    </div>
                  </div>
                </div>

                {isRecent && (
                  <div className="recent-indicator">
                    <span>FRESH SIGNAL</span>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="hod-status-bar">
        <div className="status-left">
          <span className={`connection-status ${isConnected ? 'connected' : 'disconnected'}`}>
            {isConnected ? 'LIVE' : 'OFFLINE'}
          </span>
          <span className="total-volume">
            Total Volume: {performanceMetrics.totalVolume}K
          </span>
        </div>
        <div className="status-right">
          {stats && (
            <>
              <span>Tracking: {stats.symbolsTracked} symbols</span>
              <span>Updated: {stats.lastUpdate}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

// Export without memo to ensure immediate re-renders during debugging
export default HODBreakFeed;