import React, { useEffect, useRef, memo } from 'react';
import { ScannerWindowProps } from '../types';
import './ScannerWindow.css';

const ScannerWindow: React.FC<ScannerWindowProps> = ({
  title,
  color,
  priority,
  alerts,
  pattern
}) => {
  const windowRef = useRef<HTMLDivElement>(null);
  const alertsRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to newest alerts
  useEffect(() => {
    if (alertsRef.current) {
      alertsRef.current.scrollTop = alertsRef.current.scrollHeight;
    }
  }, [alerts]);

  const formatTime = (timestamp: number): string => {
    return new Date(timestamp).toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  };

  const formatVolume = (volume: number): string => {
    if (volume >= 1000000) {
      return `${(volume / 1000000).toFixed(1)}M`;
    } else if (volume >= 1000) {
      return `${(volume / 1000).toFixed(0)}k`;
    }
    return volume.toString();
  };

  const getPatternDescription = (pattern: string): string => {
    const descriptions = {
      'ToppingTail1m': '1-minute topping tail pattern near HOD',
      'HODBreakCloseUnder': 'HOD break and close back under the HOD level',
      'Run4PlusGreenThenRed': 'Multiple green candles followed by red close'
    };
    return descriptions[pattern as keyof typeof descriptions] || 'Pattern description';
  };

  const priorityClass = priority === 1 ? 'high-priority' : priority === 2 ? 'medium-priority' : 'low-priority';

  return (
    <div
      ref={windowRef}
      className={`scanner-window ${priorityClass}`}
      style={{ '--window-color': color } as React.CSSProperties}
    >
      {/* Header */}
      <div className="window-header">
        <div className="window-title">{title}</div>
        <div className="alert-count">
          {alerts.length > 0 && (
            <span className="alert-badge">{alerts.length}</span>
          )}
        </div>
      </div>

      {/* Pattern description */}
      <div className="pattern-description">
        <code>{getPatternDescription(pattern)}</code>
      </div>

      {/* Terminal-style content area */}
      <div className="window-content" ref={alertsRef}>
        {alerts.length === 0 ? (
          <div className="no-alerts">
            <div>Waiting for alerts...</div>
          </div>
        ) : (
          alerts.map((alert, index) => (
            <div key={alert.id} className={`alert-line ${alert.historical ? 'historical' : 'live'}`}>
              <div className="alert-header">
                <span className="timestamp">[{formatTime(alert.timestamp)}]</span>
                <span className="symbol">{alert.symbol}</span>
                <span className="price">${alert.price.toFixed(2)}</span>
                <span className="volume">{formatVolume(alert.volume)}</span>
                {alert.historical && <span className="historical-tag">HIST</span>}
              </div>
              <div className="alert-detail">
                <span className="prompt">→</span>
                <span className="detail-text">{alert.detail}</span>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Status bar */}
      <div className="window-status">
        <span className="status-text">
          {alerts.length > 0 ? `Last: ${formatTime(alerts[alerts.length - 1]?.timestamp)}` : 'No data'}
        </span>
        <span className="pattern-type">{pattern}</span>
      </div>
    </div>
  );
};

export default memo(ScannerWindow);