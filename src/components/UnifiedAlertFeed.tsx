import React, { useEffect, useRef, memo, useMemo, useState, useCallback } from 'react';
import './UnifiedAlertFeed.css';
import { Alert, PatternType } from '../types';
import { soundService } from '../services/SoundService';

interface UnifiedAlertFeedProps {
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

// Pattern configuration for G-Class colors and labels
const PATTERN_CONFIGS: Record<PatternType, { title: string; color: string; priority: number }> = {
  'ToppingTail1m': { title: 'Topping Tail 1m', color: '#c9aa96', priority: 1 },
  'HODBreakCloseUnder': { title: 'HOD Break Close Under', color: '#e6d7c8', priority: 1 },
  'Run4PlusGreenThenRed': { title: '4+ Green Then Red', color: '#a08b7a', priority: 3 },
};

const UnifiedAlertFeed: React.FC<UnifiedAlertFeedProps> = ({
  alerts,
  voiceAlertsEnabled,
  soundAlertsEnabled,
  selectedSound,
  isConnected = false,
  stats,
  symbols = []
}) => {
  const [showFilters, setShowFilters] = useState(false);
  const prevAlertsLength = useRef(alerts.length);

  // Filter state
  const [symbolFilter, setSymbolFilter] = useState('');
  const [patternFilter, setPatternFilter] = useState<PatternType | 'all'>('all');
  const [timeFilter, setTimeFilter] = useState<'all' | '1h' | '30m' | '10m' | '5m'>('all');

  // Sound and voice alerts for new incoming signals - optimized for immediate response
  useEffect(() => {
    if (alerts.length > prevAlertsLength.current && alerts.length > 0) {
      const newAlerts = alerts.slice(prevAlertsLength.current);

      // Process each new alert immediately
      newAlerts.forEach(async (newAlert) => {
        const config = PATTERN_CONFIGS[newAlert.type];

        // Play sound alert immediately if enabled
        if (soundAlertsEnabled && selectedSound !== 'none') {
          try {
            await soundService.playSound(selectedSound);
          } catch (error) {
            console.warn('Sound alert failed:', error);
          }
        }

        // Play voice alert if enabled
        if (voiceAlertsEnabled && 'speechSynthesis' in window) {
          const utterance = new SpeechSynthesisUtterance(`New ${config.title} signal for ${newAlert.symbol}`);
          utterance.rate = 1.2;
          utterance.pitch = 1.0;
          utterance.volume = 0.8;
          window.speechSynthesis.speak(utterance);
        }

        // Browser notification (if permission granted)
        if ('Notification' in window && Notification.permission === 'granted') {
          new Notification(`Short Selling Scanner - ${config.title}`, {
            body: `${newAlert.symbol}: ${newAlert.detail}`,
            icon: '/icon.png',
            badge: '/icon.png',
            tag: `alert-${newAlert.symbol}`,
            requireInteraction: false,
            silent: false
          });
        }
      });
    }
    prevAlertsLength.current = alerts.length;
  }, [alerts, voiceAlertsEnabled, soundAlertsEnabled, selectedSound]);

  // Filter and sort alerts - memoized for performance
  const filteredAndSortedAlerts = useMemo(() => {
    const now = Date.now();

    // Apply filters
    let filtered = alerts.filter(alert => {

      // Symbol filter
      if (symbolFilter && !alert.symbol.toLowerCase().includes(symbolFilter.toLowerCase())) {
        return false;
      }

      // Pattern filter
      if (patternFilter !== 'all' && alert.type !== patternFilter) {
        return false;
      }


      // Time filter
      if (timeFilter !== 'all') {
        const timeInMs = {
          '5m': 5 * 60 * 1000,
          '10m': 10 * 60 * 1000,
          '30m': 30 * 60 * 1000,
          '1h': 60 * 60 * 1000,
        }[timeFilter];

        if (timeInMs && now - alert.timestamp > timeInMs) {
          return false;
        }
      }

      return true;
    });

    // Sort by timestamp (newest first) and priority
    return filtered.sort((a, b) => {
      // First by timestamp (newest first)
      const timeDiff = b.timestamp - a.timestamp;
      if (timeDiff !== 0) return timeDiff;

      // Then by priority (higher priority first)
      const configA = PATTERN_CONFIGS[a.type];
      const configB = PATTERN_CONFIGS[b.type];
      return configA.priority - configB.priority;
    });
  }, [alerts, symbolFilter, patternFilter, timeFilter]);

  const requestNotificationPermission = useCallback(async () => {
    if ('Notification' in window && Notification.permission === 'default') {
      await Notification.requestPermission();
    }
  }, []);

  // Clear filters handler
  const clearFilters = useCallback(() => {
    setSymbolFilter('');
    setPatternFilter('all');
    setTimeFilter('all');
  }, []);

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

  return (
    <div className="unified-alert-feed">
      <div className="feed-header">
        <div className="feed-title">
          <span className="feed-label">LIVE SIGNAL FEED</span>
          <span className="feed-count">
            {filteredAndSortedAlerts.length} / {alerts.length} ALERTS
          </span>
        </div>
        <div className="feed-controls">
          <button
            className={`filter-toggle ${showFilters ? 'active' : ''}`}
            onClick={() => setShowFilters(!showFilters)}
            title="Toggle Filters"
          >
            <span>FILTERS</span>
          </button>
          {Notification.permission === 'default' && (
            <button
              className="filter-toggle"
              onClick={requestNotificationPermission}
              title="Enable Browser Notifications"
            >
              <span>🔔 NOTIFICATIONS</span>
            </button>
          )}
        </div>
      </div>

      {showFilters && (
        <div className="filter-panel">
          <div className="filter-row">
            <div className="filter-group">
              <label>Symbol:</label>
              <input
                type="text"
                value={symbolFilter}
                onChange={(e) => setSymbolFilter(e.target.value)}
                placeholder="Search symbols..."
                className="filter-input"
              />
            </div>

            <div className="filter-group">
              <label>Pattern:</label>
              <select
                value={patternFilter}
                onChange={(e) => setPatternFilter(e.target.value as PatternType | 'all')}
                className="filter-select"
              >
                <option value="all">All Patterns</option>
                {Object.entries(PATTERN_CONFIGS).map(([pattern, config]) => (
                  <option key={pattern} value={pattern}>
                    {config.title}
                  </option>
                ))}
              </select>
            </div>


            <div className="filter-group">
              <label>Time:</label>
              <select
                value={timeFilter}
                onChange={(e) => setTimeFilter(e.target.value as any)}
                className="filter-select"
              >
                <option value="all">All Time</option>
                <option value="5m">Last 5m</option>
                <option value="10m">Last 10m</option>
                <option value="30m">Last 30m</option>
                <option value="1h">Last 1h</option>
              </select>
            </div>

            <button
              onClick={clearFilters}
              className="clear-filters-btn"
              title="Clear All Filters"
            >
              CLEAR
            </button>
          </div>
        </div>
      )}


      <div className="alert-feed-container">
        {filteredAndSortedAlerts.length === 0 ? (
          <div className="no-alerts">
            <div className="no-alerts-main">
              {alerts.length === 0 ? 'WAITING FOR SIGNALS' : 'NO MATCHING ALERTS'}
            </div>
            <div className="no-alerts-sub">
              {alerts.length === 0
                ? 'Monitoring gap stocks for short patterns'
                : 'Try adjusting your filters'
              }
            </div>
          </div>
        ) : (
          filteredAndSortedAlerts.map((alert) => {
            const config = PATTERN_CONFIGS[alert.type];
            const isRecent = Date.now() - alert.timestamp < 60000; // Last 1 minute

            return (
              <div
                key={alert.id}
                className={`alert-item ${isRecent ? 'recent' : ''}`}
                style={{ borderLeftColor: config.color }}
              >
                <div className="alert-main">
                  <div className="alert-symbol-and-pattern">
                    <span className="alert-symbol">{alert.symbol}</span>
                    <span
                      className="alert-pattern"
                      style={{ color: config.color }}
                    >
                      {config.title}
                    </span>
                  </div>

                  <div className="alert-details">
                    <span className="alert-price">${alert.price.toFixed(2)}</span>
                    <span className="alert-volume">{(alert.volume / 1000).toFixed(0)}k vol</span>
                    {alert.gapPercent !== undefined && alert.gapPercent !== null && (
                      <span className="alert-gap">{alert.gapPercent > 0 ? '+' : ''}{alert.gapPercent.toFixed(1)}% gap</span>
                    )}
                  </div>
                </div>

                <div className="alert-meta">
                  <div className="alert-description">{alert.detail}</div>
                  <div className="alert-time-container">
                    <div className="alert-time-main">{formatTime(alert.timestamp)}</div>
                    <div className="alert-time-relative">{getTimeSinceAlert(alert.timestamp)}</div>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Inline Status Bar */}
      <div className="unified-status-bar">
        <div className="status-section">
          <span className={`connection-status ${isConnected ? 'connected' : 'disconnected'}`}>
            {isConnected ? '🟢 CONNECTED' : '🔴 DISCONNECTED'}
          </span>
        </div>
        <div className="status-section">
          {stats && (
            <>
              <span className="status-stat">{stats.totalAlerts} ALERTS</span>
              <span className="status-stat">{stats.symbolsTracked} SYMBOLS</span>
              <span className="status-stat">UPDATED {stats.lastUpdate}</span>
            </>
          )}
        </div>
        <div className="status-section">
          <span className="status-symbols">
            {symbols.length > 0 ? symbols.slice(0, 5).join(', ') + (symbols.length > 5 ? '...' : '') : 'No symbols'}
          </span>
        </div>
      </div>
    </div>
  );
};

export default memo(UnifiedAlertFeed);