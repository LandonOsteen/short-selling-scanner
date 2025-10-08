/**
 * Real-time WebSocket-based pattern scanner
 *
 * Uses Polygon's WebSocket API to receive 1-minute aggregates in real-time,
 * builds 5-minute candles, and detects patterns as they form.
 */

import { Alert, BarData } from '../types';
import { ScannerConfig } from '../config/scannerConfig';

interface PolygonMinuteAggregate {
  ev: 'AM';
  sym: string;        // Symbol
  v: number;          // Volume
  av: number;         // Accumulated volume (today)
  op: number;         // Today's opening price
  vw: number;         // Volume weighted average price
  o: number;          // Open
  c: number;          // Close
  h: number;          // High
  l: number;          // Low
  a: number;          // VWAP
  z: number;          // Average trade size
  s: number;          // Start timestamp (Unix milliseconds)
  e: number;          // End timestamp (Unix milliseconds)
  otc?: boolean;      // OTC flag
}

interface MinuteCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface SymbolState {
  symbol: string;
  minuteCandles: MinuteCandle[];  // Buffer of recent 1-minute candles
  hod: number;                     // High of day
  gapPercent: number;              // Gap percentage
  previousClose: number;           // Previous day close
  lastProcessed5MinBoundary: number; // Last 5-min boundary we processed
}

export class WebSocketScanner {
  private ws: WebSocket | null = null;
  private apiKey: string;
  private config: ScannerConfig;
  private symbols: Map<string, SymbolState> = new Map();
  private alertCallbacks: ((alert: Alert) => void)[] = [];
  private firedAlertIds: Set<string> = new Set();
  private isConnected: boolean = false;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;
  private reconnectDelay: number = 5000; // 5 seconds
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private lastMessageTime: number = 0;
  private messageCount: number = 0;

  // Pattern detection methods (copied from GapScanner)
  private detectToppingTail5m: (symbol: string, bars5m: BarData[], index: number, hod: number, timestamp: Date, cumulativeVolume?: number, gapPercent?: number) => Alert | null;
  private detectGreenRunReject: (symbol: string, bars5m: BarData[], index: number, hod: number, timestamp: Date, cumulativeVolume?: number, gapPercent?: number) => Alert | null;
  private detectTestSignal: (symbol: string, bars5m: BarData[], index: number, hod: number, timestamp: Date, cumulativeVolume?: number, gapPercent?: number) => Alert | null;

  constructor(
    apiKey: string,
    config: ScannerConfig,
    patternDetectors: {
      detectToppingTail5m: any;
      detectGreenRunReject: any;
      detectTestSignal: any;
    }
  ) {
    this.apiKey = apiKey;
    this.config = config;
    this.detectToppingTail5m = patternDetectors.detectToppingTail5m;
    this.detectGreenRunReject = patternDetectors.detectGreenRunReject;
    this.detectTestSignal = patternDetectors.detectTestSignal;

    console.log('🔌 WebSocketScanner initialized');
  }

  /**
   * Connect to Polygon WebSocket and subscribe to symbols
   */
  async connect(symbolsData: Array<{ symbol: string; gapPercent: number; previousClose: number; currentPrice: number }>): Promise<void> {
    console.log('\n' + '='.repeat(80));
    console.log('🔌 WEBSOCKET: Connecting to Polygon...');
    console.log('='.repeat(80));

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(`wss://socket.polygon.io/stocks`);

        this.ws.onopen = () => {
          console.log('✅ WebSocket connection opened');
        };

        this.ws.onmessage = async (event) => {
          const messages = JSON.parse(event.data);

          for (const msg of messages) {
            // Handle authentication
            if (msg.ev === 'status' && msg.status === 'auth_success') {
              console.log('✅ WebSocket authenticated successfully');
              this.isConnected = true;
              this.reconnectAttempts = 0;

              // Initialize symbols and backfill recent data
              await this.initializeSymbols(symbolsData);

              // Subscribe to minute aggregates for all symbols
              await this.subscribeToSymbols();

              // Start heartbeat
              this.startHeartbeat();

              resolve();
            } else if (msg.ev === 'status' && msg.status === 'auth_failed') {
              console.error('❌ WebSocket authentication failed');
              reject(new Error('Authentication failed'));
            } else if (msg.ev === 'AM') {
              // Handle minute aggregate
              this.handleMinuteAggregate(msg as PolygonMinuteAggregate);
            } else if (msg.ev === 'status') {
              console.log(`📡 Status message: ${msg.message || JSON.stringify(msg)}`);
            }
          }
        };

        this.ws.onerror = (error) => {
          console.error('❌ WebSocket error:', error);
          reject(error);
        };

        this.ws.onclose = (event) => {
          console.log(`🔌 WebSocket closed: code=${event.code}, reason=${event.reason || 'none'}`);
          this.isConnected = false;
          this.stopHeartbeat();
          this.handleReconnect();
        };

        // Send authentication message
        this.ws.onopen = () => {
          console.log('📤 Sending authentication...');
          this.ws!.send(JSON.stringify({ action: 'auth', params: this.apiKey }));
        };

      } catch (error) {
        console.error('❌ Failed to create WebSocket:', error);
        reject(error);
      }
    });
  }

  /**
   * Initialize symbol states and backfill recent 1-minute candles
   */
  private async initializeSymbols(symbolsData: Array<{ symbol: string; gapPercent: number; previousClose: number; currentPrice: number }>): Promise<void> {
    console.log(`\n📊 Initializing ${symbolsData.length} symbols...`);

    for (const data of symbolsData) {
      this.symbols.set(data.symbol, {
        symbol: data.symbol,
        minuteCandles: [],
        hod: data.currentPrice, // Initialize with current price
        gapPercent: data.gapPercent,
        previousClose: data.previousClose,
        lastProcessed5MinBoundary: 0
      });
      console.log(`   ✅ ${data.symbol}: gap=${data.gapPercent.toFixed(1)}%, HOD=${data.currentPrice.toFixed(2)}`);
    }

    // Backfill recent 1-minute candles for each symbol
    console.log(`\n📥 Backfilling recent 1-minute candles...`);
    await this.backfillRecentCandles(symbolsData.map(s => s.symbol));
  }

  /**
   * Backfill recent 1-minute candles for all symbols
   * Fetches the last 2 hours of 1-minute bars so we have history for pattern detection
   */
  private async backfillRecentCandles(symbols: string[]): Promise<void> {
    const now = new Date();
    const twoHoursAgo = new Date(now.getTime() - 120 * 60 * 1000);

    // Get today's date in ET for the API call
    const etNow = new Date(now.toLocaleString("en-US", {timeZone: "America/New_York"}));
    const dateString = `${etNow.getFullYear()}-${String(etNow.getMonth() + 1).padStart(2, '0')}-${String(etNow.getDate()).padStart(2, '0')}`;

    console.log(`   Fetching 1-minute bars from ${this.formatETTime(twoHoursAgo)} to now`);
    console.log(`   Date: ${dateString}`);

    for (const symbol of symbols) {
      try {
        // Fetch 1-minute bars for the last 10 minutes
        const url = `https://api.polygon.io/v2/aggs/ticker/${symbol}/range/1/minute/${dateString}/${dateString}?adjusted=true&sort=asc&limit=50000&apikey=${this.apiKey}`;

        const response = await fetch(url);
        const data = await response.json();

        if (!data.results || data.results.length === 0) {
          console.log(`   ⚠️  ${symbol}: No recent 1-minute data available`);
          continue;
        }

        const symbolState = this.symbols.get(symbol);
        if (!symbolState) continue;

        // Filter to only last 2 hours and convert to our format
        const recentBars = data.results
          .filter((bar: any) => bar.t >= twoHoursAgo.getTime())
          .map((bar: any) => ({
            timestamp: bar.t,
            open: bar.o,
            high: bar.h,
            low: bar.l,
            close: bar.c,
            volume: bar.v
          }));

        // Add to symbol's buffer
        symbolState.minuteCandles = recentBars;

        // Update HOD from backfilled data
        const maxHigh = Math.max(...recentBars.map((b: MinuteCandle) => b.high));
        if (maxHigh > symbolState.hod) {
          symbolState.hod = maxHigh;
        }

        console.log(`   ✅ ${symbol}: Loaded ${recentBars.length} 1-minute candles, HOD=${symbolState.hod.toFixed(2)}`);

        // Check if we can build a 5-minute candle immediately
        this.checkAndProcess5MinCandle(symbol, symbolState);

      } catch (error) {
        console.error(`   ❌ ${symbol}: Backfill failed:`, error);
      }

      // Small delay to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    console.log(`   ✅ Backfill complete\n`);
  }

  /**
   * Subscribe to minute aggregates for all symbols
   */
  private async subscribeToSymbols(): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error('❌ Cannot subscribe: WebSocket not ready');
      return;
    }

    const symbolsList = Array.from(this.symbols.keys());

    if (symbolsList.length === 0) {
      console.warn('⚠️  No symbols to subscribe to');
      return;
    }

    // Build subscription string: "AM.SYMBOL1,AM.SYMBOL2,..."
    const subscriptionParams = symbolsList.map(s => `AM.${s}`).join(',');

    console.log(`📡 Subscribing to minute aggregates for ${symbolsList.length} symbols...`);
    console.log(`   Symbols: ${symbolsList.join(', ')}`);

    const subscribeMessage = {
      action: 'subscribe',
      params: subscriptionParams
    };

    this.ws.send(JSON.stringify(subscribeMessage));
    console.log('✅ Subscription request sent');
  }

  /**
   * Handle incoming minute aggregate
   */
  private handleMinuteAggregate(agg: PolygonMinuteAggregate): void {
    // Update message tracking
    this.lastMessageTime = Date.now();
    this.messageCount++;

    const symbolState = this.symbols.get(agg.sym);

    if (!symbolState) {
      // Received data for symbol we're not tracking - ignore
      return;
    }

    const candle: MinuteCandle = {
      timestamp: agg.s, // Start timestamp
      open: agg.o,
      high: agg.h,
      low: agg.l,
      close: agg.c,
      volume: agg.v
    };

    // Update HOD
    if (agg.h > symbolState.hod) {
      const oldHOD = symbolState.hod;
      symbolState.hod = agg.h;
      console.log(`📈 ${agg.sym} NEW HOD: ${oldHOD.toFixed(2)} → ${agg.h.toFixed(2)}`);
    }

    // Add candle to buffer
    symbolState.minuteCandles.push(candle);

    // Keep only last 120 minutes of data (enough for 20 5-minute candles + buffer)
    if (symbolState.minuteCandles.length > 120) {
      symbolState.minuteCandles.shift();
    }

    console.log(`📊 ${agg.sym} 1m candle: ${this.formatETTime(new Date(agg.s))} | O:${agg.o.toFixed(2)} H:${agg.h.toFixed(2)} L:${agg.l.toFixed(2)} C:${agg.c.toFixed(2)} V:${agg.v}`);

    // Check if this completes a 5-minute candle
    this.checkAndProcess5MinCandle(agg.sym, symbolState);
  }

  /**
   * Check if we have a complete 5-minute candle and process it
   */
  private checkAndProcess5MinCandle(symbol: string, state: SymbolState): void {
    if (state.minuteCandles.length === 0) return;

    const latestCandle = state.minuteCandles[state.minuteCandles.length - 1];
    const candleTime = new Date(latestCandle.timestamp);
    const etTime = new Date(candleTime.toLocaleString("en-US", {timeZone: "America/New_York"}));
    const minutes = etTime.getMinutes();

    // Check if this candle COMPLETES a 5-minute period (minutes = 4, 9, 14, 19, 24, etc.)
    // This is the LAST candle of a 5-minute period, so we can process immediately
    // For example: when we receive 16:19:00 candle, the 16:15-16:19 period is complete
    // No need to wait for 16:20:00 to start!
    const periodMinute = minutes % 5; // 0-4 within the current 5-minute period
    const isLastCandleOfPeriod = (periodMinute === 4); // 4, 9, 14, 19, 24, 29, 34, 39, 44, 49, 54, 59

    if (!isLastCandleOfPeriod) {
      return; // Not the last candle of the period yet
    }

    // Calculate the period that just completed with this candle
    // Use setMinutes to handle hour boundaries automatically
    const completedPeriodTime = new Date(etTime);
    const periodStartMinute = Math.floor(minutes / 5) * 5; // Round down to nearest 5
    completedPeriodTime.setMinutes(periodStartMinute, 0, 0);
    const completedPeriodTimestamp = completedPeriodTime.getTime();
    const completedPeriodStart = completedPeriodTime.getMinutes();

    // Check if we already processed this period
    if (completedPeriodTimestamp <= state.lastProcessed5MinBoundary) {
      return; // Already processed
    }

    const completedPeriodEnd = (completedPeriodStart + 4) % 60;
    const completedHour = completedPeriodTime.getHours();

    console.log(`\n${'⏰'.repeat(40)}`);
    console.log(`⏰ ${symbol} - 5-MIN PERIOD COMPLETED with ${this.formatETTime(etTime)} candle`);
    console.log(`   ✅ Processing COMPLETED period: ${completedHour}:${String(completedPeriodStart).padStart(2,'0')}-${completedHour}:${String(completedPeriodEnd).padStart(2,'0')}`);
    console.log(`   ⚡ INSTANT ALERT: No delay - processing immediately!`);
    console.log(`${'⏰'.repeat(40)}`);

    // We need 5 consecutive 1-minute candles from the completed period
    // For period 10-14, we need candles at: 10, 11, 12, 13, 14
    const required1MinCandles: MinuteCandle[] = [];

    for (let offset = 0; offset < 5; offset++) {
      const targetMinute = completedPeriodStart + offset;
      const targetTime = new Date(completedPeriodTime);
      targetTime.setMinutes(targetMinute);
      const targetTimestamp = targetTime.getTime();

      const candle = state.minuteCandles.find(c => {
        const cTime = new Date(c.timestamp);
        const cET = new Date(cTime.toLocaleString("en-US", {timeZone: "America/New_York"}));
        return cET.getMinutes() === targetMinute &&
               Math.abs(c.timestamp - targetTimestamp) < 120000; // Within 2 minutes tolerance
      });

      if (candle) {
        required1MinCandles.push(candle);
      }
    }

    console.log(`   Found ${required1MinCandles.length}/5 required 1-minute candles`);

    if (required1MinCandles.length < 5) {
      console.log(`   ⚠️  Insufficient data to build 5-minute candle - need 5, have ${required1MinCandles.length}`);
      return;
    }

    // Build 5-minute candle from the 5 1-minute candles
    const fiveMinCandle = this.aggregate5MinCandle(required1MinCandles);

    console.log(`   📊 5m Candle [${completedPeriodStart}:00-${completedPeriodStart + 4}:59]: O:${fiveMinCandle.open.toFixed(2)} H:${fiveMinCandle.high.toFixed(2)} L:${fiveMinCandle.low.toFixed(2)} C:${fiveMinCandle.close.toFixed(2)} V:${fiveMinCandle.volume}`);

    // Mark this boundary as processed
    state.lastProcessed5MinBoundary = completedPeriodTimestamp;

    // Run pattern detection on the 5-minute candle
    this.detectPatterns(symbol, state, fiveMinCandle, completedPeriodTime);
  }

  /**
   * Aggregate 5 1-minute candles into one 5-minute candle
   */
  private aggregate5MinCandle(candles: MinuteCandle[]): BarData {
    // Sort by timestamp to ensure correct order
    const sorted = candles.sort((a, b) => a.timestamp - b.timestamp);

    // Use the close time (last candle's timestamp + 1 minute) as the candle timestamp
    // This represents when the period actually closes
    // For 16:30-16:34 period, timestamp will be 16:35:00
    const closeTime = new Date(sorted[sorted.length - 1].timestamp);
    closeTime.setMinutes(closeTime.getMinutes() + 1);

    return {
      timestamp: closeTime.getTime(), // Use close time of the period
      open: sorted[0].open,           // Open from first candle
      high: Math.max(...sorted.map(c => c.high)),  // Highest high
      low: Math.min(...sorted.map(c => c.low)),    // Lowest low
      close: sorted[sorted.length - 1].close,      // Close from last candle
      volume: sorted.reduce((sum, c) => sum + c.volume, 0) // Sum of all volumes
    };
  }

  /**
   * Run pattern detection on completed 5-minute candle
   */
  private detectPatterns(symbol: string, state: SymbolState, candle: BarData, timestamp: Date): void {
    console.log(`\n🔍 Running pattern detection for ${symbol} at ${this.formatETTime(timestamp)}...`);

    // Build historical 5-minute candles from our 1-minute buffer
    // We need this for patterns like GreenRunReject that look at previous candles
    const bars5m = this.build5MinCandleHistory(state, timestamp);

    // Add the current candle to the end
    bars5m.push(candle);
    const index = bars5m.length - 1; // Current candle is the last one

    console.log(`   📊 Built history of ${bars5m.length} 5-minute candles for pattern detection`);

    // Convert BarData to match expected format
    const barsWithProperties = bars5m.map(bar => ({
      t: bar.timestamp,
      o: bar.open,
      h: bar.high,
      l: bar.low,
      c: bar.close,
      v: bar.volume,
      vw: (bar.open + bar.close) / 2, // Approximate VWAP
      n: 1
    }));

    const patterns: (Alert | null)[] = [
      this.detectToppingTail5m.call(this, symbol, barsWithProperties as any, index, state.hod, timestamp, candle.volume, state.gapPercent),
      this.detectGreenRunReject.call(this, symbol, barsWithProperties as any, index, state.hod, timestamp, candle.volume, state.gapPercent),
    ];

    // Only check test signal if enabled
    if (this.config.development?.enableTestSignal) {
      patterns.push(
        this.detectTestSignal.call(this, symbol, barsWithProperties as any, index, state.hod, timestamp, candle.volume, state.gapPercent)
      );
    }

    patterns.forEach(alert => {
      if (alert) {
        console.log(`🎯 PATTERN DETECTED: ${alert.type} for ${alert.symbol}`);
        this.fireAlert(alert);
      }
    });

    if (patterns.every(p => p === null)) {
      console.log(`   ✅ No patterns detected`);
    }
  }

  /**
   * Build historical 5-minute candles from 1-minute buffer
   * Returns up to last 20 5-minute candles (for patterns that need history)
   */
  private build5MinCandleHistory(state: SymbolState, currentTimestamp: Date): BarData[] {
    const history: BarData[] = [];

    // Get the current 5-minute period
    const etTime = new Date(currentTimestamp.toLocaleString("en-US", {timeZone: "America/New_York"}));
    const currentMinute = etTime.getMinutes();
    const currentPeriodStart = Math.floor(currentMinute / 5) * 5;

    // Build up to 20 previous 5-minute candles (100 minutes of history)
    for (let periodsBack = 20; periodsBack > 0; periodsBack--) {
      const periodStart = currentPeriodStart - (periodsBack * 5);
      const periodTime = new Date(etTime);
      periodTime.setMinutes(periodStart, 0, 0);

      // Try to build this 5-minute candle from our buffer
      const fiveMinCandles: MinuteCandle[] = [];

      for (let offset = 0; offset < 5; offset++) {
        const targetMinute = periodStart + offset;
        const targetTime = new Date(periodTime);
        targetTime.setMinutes(targetMinute);
        const targetTimestamp = targetTime.getTime();

        const candle = state.minuteCandles.find(c => {
          const cTime = new Date(c.timestamp);
          const cET = new Date(cTime.toLocaleString("en-US", {timeZone: "America/New_York"}));
          return cET.getMinutes() === targetMinute % 60 && // Handle hour rollover
                 Math.abs(c.timestamp - targetTimestamp) < 120000;
        });

        if (candle) {
          fiveMinCandles.push(candle);
        }
      }

      // Only add if we have all 5 candles for this period
      if (fiveMinCandles.length === 5) {
        history.push(this.aggregate5MinCandle(fiveMinCandles));
      }
    }

    return history;
  }

  /**
   * Fire alert to all callbacks
   */
  private fireAlert(alert: Alert): void {
    // Check for duplicates
    if (this.firedAlertIds.has(alert.id)) {
      console.log(`⏭️  Skipping duplicate alert: ${alert.id}`);
      return;
    }

    this.firedAlertIds.add(alert.id);

    // Clean up old IDs
    if (this.firedAlertIds.size > 1000) {
      const ids = Array.from(this.firedAlertIds);
      ids.slice(0, 500).forEach(id => this.firedAlertIds.delete(id));
    }

    console.log(`\n🔔 FIRING ALERT: ${alert.type} for ${alert.symbol} at ${new Date(alert.timestamp).toLocaleTimeString()}`);
    console.log(`   Callbacks registered: ${this.alertCallbacks.length}`);

    this.alertCallbacks.forEach((callback, index) => {
      try {
        callback(alert);
        console.log(`   ✅ Callback ${index + 1} executed`);
      } catch (error) {
        console.error(`   ❌ Error in callback ${index + 1}:`, error);
      }
    });
  }

  /**
   * Register alert callback - returns unsubscribe function
   */
  onAlert(callback: (alert: Alert) => void): () => void {
    console.log(`📝 Registering alert callback (total: ${this.alertCallbacks.length + 1})`);
    this.alertCallbacks.push(callback);

    // Return unsubscribe function
    return () => {
      const index = this.alertCallbacks.indexOf(callback);
      if (index > -1) {
        this.alertCallbacks.splice(index, 1);
        console.log(`🗑️  WebSocket alert callback removed (remaining: ${this.alertCallbacks.length})`);
      }
    };
  }

  /**
   * Update watched symbols
   */
  async updateSymbols(symbolsData: Array<{ symbol: string; gapPercent: number; previousClose: number; currentPrice: number }>): Promise<void> {
    console.log(`\n📊 Updating symbols (${symbolsData.length} symbols)...`);

    const newSymbols = new Set(symbolsData.map(s => s.symbol));
    const oldSymbols = new Set(this.symbols.keys());

    // Find symbols to add and remove
    const toAdd = symbolsData.filter(s => !oldSymbols.has(s.symbol));
    const toRemove = Array.from(oldSymbols).filter(s => !newSymbols.has(s));

    // Unsubscribe from removed symbols
    if (toRemove.length > 0 && this.ws && this.ws.readyState === WebSocket.OPEN) {
      const unsubParams = toRemove.map(s => `AM.${s}`).join(',');
      this.ws.send(JSON.stringify({ action: 'unsubscribe', params: unsubParams }));
      toRemove.forEach(s => this.symbols.delete(s));
      console.log(`   🔴 Unsubscribed from: ${toRemove.join(', ')}`);
    }

    // Add new symbols
    if (toAdd.length > 0) {
      for (const data of toAdd) {
        this.symbols.set(data.symbol, {
          symbol: data.symbol,
          minuteCandles: [],
          hod: data.currentPrice,
          gapPercent: data.gapPercent,
          previousClose: data.previousClose,
          lastProcessed5MinBoundary: 0
        });
      }

      // Subscribe to new symbols
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        const subParams = toAdd.map(s => `AM.${s.symbol}`).join(',');
        this.ws.send(JSON.stringify({ action: 'subscribe', params: subParams }));
        console.log(`   🟢 Subscribed to: ${toAdd.map(s => s.symbol).join(', ')}`);
      }
    }

    console.log(`   📊 Total symbols tracked: ${this.symbols.size}`);
  }

  /**
   * Start heartbeat to keep connection alive and log status
   */
  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        const timeSinceLastMessage = Date.now() - this.lastMessageTime;
        const secondsSince = Math.floor(timeSinceLastMessage / 1000);

        console.log(`\n${'💓'.repeat(20)}`);
        console.log(`💓 WebSocket HEARTBEAT - Status Check`);
        console.log(`   Connection: ${this.isConnected ? '🟢 CONNECTED' : '🔴 DISCONNECTED'}`);
        console.log(`   Symbols tracked: ${this.symbols.size}`);
        console.log(`   Messages received: ${this.messageCount}`);
        console.log(`   Last message: ${secondsSince}s ago`);
        console.log(`   Status: ${secondsSince < 120 ? '✅ HEALTHY - Receiving data' : '⚠️  WARNING - No data for ' + secondsSince + 's'}`);
        console.log(`${'💓'.repeat(20)}\n`);
      }
    }, 30000); // Every 30 seconds
  }

  /**
   * Stop heartbeat
   */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Handle reconnection
   */
  private handleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(`❌ Max reconnection attempts (${this.maxReconnectAttempts}) reached. Giving up.`);
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1); // Exponential backoff

    console.log(`🔄 Attempting reconnection ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay / 1000}s...`);

    setTimeout(async () => {
      try {
        const symbolsData = Array.from(this.symbols.values()).map(state => ({
          symbol: state.symbol,
          gapPercent: state.gapPercent,
          previousClose: state.previousClose,
          currentPrice: state.hod
        }));

        await this.connect(symbolsData);
        console.log('✅ Reconnected successfully');
      } catch (error) {
        console.error('❌ Reconnection failed:', error);
      }
    }, delay);
  }

  /**
   * Disconnect from WebSocket
   */
  disconnect(): void {
    console.log('🔌 Disconnecting WebSocket...');
    this.stopHeartbeat();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.isConnected = false;
    console.log('✅ WebSocket disconnected');
  }

  /**
   * Check if connected
   */
  getConnectionStatus(): boolean {
    return this.isConnected && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Get detailed WebSocket status for diagnostics
   */
  getDetailedStatus(): {
    isConnected: boolean;
    symbolsTracked: number;
    messagesReceived: number;
    lastMessageTime: number;
    secondsSinceLastMessage: number;
    isHealthy: boolean;
  } {
    const timeSinceLastMessage = Date.now() - this.lastMessageTime;
    const secondsSince = Math.floor(timeSinceLastMessage / 1000);

    return {
      isConnected: this.isConnected && this.ws !== null && this.ws.readyState === WebSocket.OPEN,
      symbolsTracked: this.symbols.size,
      messagesReceived: this.messageCount,
      lastMessageTime: this.lastMessageTime,
      secondsSinceLastMessage: secondsSince,
      isHealthy: secondsSince < 120 // Healthy if we received data in last 2 minutes
    };
  }

  /**
   * Print WebSocket status to console (call this anytime to check status)
   */
  printStatus(): void {
    const status = this.getDetailedStatus();

    console.log(`\n${'📊'.repeat(30)}`);
    console.log(`📊 WEBSOCKET STATUS REPORT`);
    console.log(`${'📊'.repeat(30)}`);
    console.log(`   Connection: ${status.isConnected ? '🟢 CONNECTED' : '🔴 DISCONNECTED'}`);
    console.log(`   Symbols tracked: ${status.symbolsTracked}`);
    console.log(`   Total messages received: ${status.messagesReceived}`);
    console.log(`   Last message: ${status.secondsSinceLastMessage}s ago`);
    console.log(`   Health status: ${status.isHealthy ? '✅ HEALTHY' : '⚠️  WARNING - No recent data'}`);

    if (status.isConnected && status.symbolsTracked > 0) {
      console.log(`\n   Tracked symbols:`);
      Array.from(this.symbols.keys()).forEach((symbol, i) => {
        const state = this.symbols.get(symbol)!;
        console.log(`      ${i + 1}. ${symbol} - HOD: $${state.hod.toFixed(2)}, Gap: ${state.gapPercent.toFixed(1)}%, Candles: ${state.minuteCandles.length}`);
      });
    }

    console.log(`${'📊'.repeat(30)}\n`);
  }

  /**
   * Format time in ET
   */
  private formatETTime(date: Date): string {
    const etTime = new Date(date.toLocaleString("en-US", {timeZone: "America/New_York"}));
    return etTime.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }
}
