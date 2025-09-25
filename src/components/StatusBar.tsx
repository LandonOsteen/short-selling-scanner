import React, { memo } from 'react';
import { StatusBarProps } from '../types';
import './StatusBar.css';

const StatusBar: React.FC<StatusBarProps> = ({ isConnected, stats, symbols }) => {
  const formatUptime = (): string => {
    const startTime = Date.now() - 3600000; // 1 hour ago for demo
    const uptime = Date.now() - startTime;
    const hours = Math.floor(uptime / (1000 * 60 * 60));
    const minutes = Math.floor((uptime % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((uptime % (1000 * 60)) / 1000);

    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  };

  const getCurrentMarketPhase = (): { phase: string; color: string } => {
    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();
    const currentTime = hour * 100 + minute;

    if (currentTime >= 400 && currentTime < 930) {
      return { phase: 'PRE-MARKET', color: '#ffaa00' };
    } else if (currentTime >= 930 && currentTime < 1600) {
      return { phase: 'MARKET OPEN', color: '#00ff00' };
    } else if (currentTime >= 1600 && currentTime < 2000) {
      return { phase: 'AFTER HOURS', color: '#00aaff' };
    } else {
      return { phase: 'CLOSED', color: '#888888' };
    }
  };

  const marketPhase = getCurrentMarketPhase();

  return (
    <div className="status-bar">
      <div className="status-section">
        <div className="status-item">
          <span className="status-label">CONNECTION:</span>
          <span className={`status-value ${isConnected ? 'connected' : 'disconnected'}`}>
            {isConnected ? 'LIVE' : 'OFFLINE'}
          </span>
        </div>

        <div className="status-separator">│</div>

        <div className="status-item">
          <span className="status-label">MARKET:</span>
          <span className="status-value" style={{ color: marketPhase.color }}>
            {marketPhase.phase}
          </span>
        </div>

        <div className="status-separator">│</div>

        <div className="status-item">
          <span className="status-label">SYMBOLS:</span>
          <span className="status-value">{stats.symbolsTracked}</span>
        </div>

        <div className="status-separator">│</div>

        <div className="status-item">
          <span className="status-label">ALERTS:</span>
          <span className="status-value">{stats.totalAlerts}</span>
        </div>
      </div>

      <div className="status-section">
        <div className="status-item">
          <span className="status-label">UPTIME:</span>
          <span className="status-value">{formatUptime()}</span>
        </div>

        <div className="status-separator">│</div>

        <div className="status-item">
          <span className="status-label">LAST UPDATE:</span>
          <span className="status-value">{stats.lastUpdate}</span>
        </div>

        <div className="status-separator">│</div>

        <div className="status-item">
          <span className="status-label">SCANNER:</span>
          <span className="status-value" style={{ color: '#00ff00' }}>
            ACTIVE
          </span>
        </div>
      </div>

      {/* Scrolling ticker for active symbols */}
      <div className="symbol-ticker">
        <div className="ticker-content">
          {symbols.map((symbol, index) => (
            <span key={symbol} className="ticker-symbol">
              {symbol}
              {index < symbols.length - 1 && ' • '}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
};

export default memo(StatusBar);