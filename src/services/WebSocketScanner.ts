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
  cumulativeVolume: number;        // Cumulative session volume from start time
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

  constructor(
    apiKey: string,
    config: ScannerConfig,
    patternDetectors: {
      detectToppingTail5m: any;
      detectGreenRunReject: any;
    }
  ) {
    this.apiKey = apiKey;
    this.config = config;
    this.detectToppingTail5m = patternDetectors.detectToppingTail5m;
    this.detectGreenRunReject = patternDetectors.detectGreenRunReject;

    console.log('🔌 WebSocketScanner initialized');
  }

  /**
   * Connect to Polygon WebSocket and subscribe to symbols
   */
  async connect(symbolsData: Array<{ symbol: string; gapPercent: number; previousClose: number; currentPrice: number; hod?: number }>): Promise<void> {
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
  private async initializeSymbols(symbolsData: Array<{ symbol: string; gapPercent: number; previousClose: number; currentPrice: number; hod?: number }>): Promise<void> {
    console.log(`\n📊 Initializing ${symbolsData.length} symbols...`);

    for (const data of symbolsData) {
      // Use passed HOD if available (from gap scan), otherwise use current price as initial estimate
      const initialHOD = data.hod !== undefined ? data.hod : data.currentPrice;

      this.symbols.set(data.symbol, {
        symbol: data.symbol,
        minuteCandles: [],
        hod: initialHOD,
        gapPercent: data.gapPercent,
        previousClose: data.previousClose,
        lastProcessed5MinBoundary: 0,
        cumulativeVolume: 0 // Will be calculated during backfill
      });
      console.log(`   ✅ ${data.symbol}: gap=${data.gapPercent.toFixed(1)}%, Initial HOD=${initialHOD.toFixed(2)}${data.hod !== undefined ? ' (from gap scan)' : ' (from current price)'}`);
    }

    // Backfill recent 1-minute candles for each symbol
    console.log(`\n📥 Backfilling recent 1-minute candles...`);
    await this.backfillRecentCandles(symbolsData.map(s => s.symbol));
  }

  /**
   * Backfill recent 1-minute candles for all symbols
   * Fetches bars from market start time to ensure accurate HOD tracking
   * CRITICAL: Also includes previous day's after-hours high (4-8 PM) to match REST behavior
   */
  private async backfillRecentCandles(symbols: string[]): Promise<void> {
    const now = new Date();

    // Calculate market start time based on config (e.g., 7:00 AM or 4:00 AM ET)
    const [startHour, startMin] = this.config.marketHours.startTime.split(':').map(Number);

    // Get today's date in ET timezone
    const etDateStr = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(now);
    const [month, day, year] = etDateStr.split('/');
    const dateString = `${year}-${month}-${day}`;

    // Create market start time in ET timezone
    // We build a date string and let the system parse it
    const marketStartETStr = `${year}-${month}-${day}T${String(startHour).padStart(2, '0')}:${String(startMin).padStart(2, '0')}:00`;
    const marketStartET = new Date(marketStartETStr);
    const marketStartUTC = marketStartET.getTime();

    // Get previous trading day for after-hours data
    const previousDate = this.getPreviousTradingDay(dateString);

    console.log(`   Fetching 1-minute bars from market start (${this.config.marketHours.startTime} ET) to now`);
    console.log(`   Date: ${dateString}, Start time: ${marketStartET.toLocaleTimeString()}`);
    console.log(`   Also fetching previous day after-hours data: ${previousDate}`);

    for (const symbol of symbols) {
      try {
        // STEP 1: Fetch previous day's after-hours high (4-8 PM) to match REST behavior
        const afterHoursHigh = await this.getAfterHoursHigh(symbol, previousDate);

        // STEP 2: Fetch ALL 1-minute bars for today
        const url = `https://api.polygon.io/v2/aggs/ticker/${symbol}/range/1/minute/${dateString}/${dateString}?adjusted=true&sort=asc&limit=50000&include_extended_hours=true&apikey=${this.apiKey}`;

        const response = await fetch(url);
        const data = await response.json();

        if (!data.results || data.results.length === 0) {
          console.log(`   ⚠️  ${symbol}: No recent 1-minute data available`);
          continue;
        }

        const symbolState = this.symbols.get(symbol);
        if (!symbolState) continue;

        // STEP 3: Calculate TRUE HOD from ALL bars (including early pre-market)
        // HOD should ALWAYS include full pre-market regardless of configured start time
        // For example: config might start at 7AM but pre-market high at 5AM should count
        const allBarsForHOD = data.results.map((bar: any) => ({
          timestamp: bar.t,
          high: bar.h
        }));
        const todayMaxHigh = allBarsForHOD.length > 0 ? Math.max(...allBarsForHOD.map((b: any) => b.high)) : 0;
        symbolState.hod = Math.max(afterHoursHigh, todayMaxHigh);

        // STEP 4: Filter to only bars from CONFIGURED market start onwards for buffer and volume
        // Volume calculation should ONLY include bars from configured start time
        const recentBars = data.results
          .filter((bar: any) => bar.t >= marketStartUTC)
          .map((bar: any) => ({
            timestamp: bar.t,
            open: bar.o,
            high: bar.h,
            low: bar.l,
            close: bar.c,
            volume: bar.v
          }));

        // Add to symbol's buffer (only bars from configured start time)
        symbolState.minuteCandles = recentBars;

        // Calculate cumulative volume ONLY from bars within configured hours
        // CRITICAL: This must match REST API behavior
        symbolState.cumulativeVolume = recentBars.reduce((sum: number, bar: MinuteCandle) => sum + bar.volume, 0);

        console.log(`   ✅ ${symbol}: Loaded ${recentBars.length} 1-minute candles from ${this.config.marketHours.startTime} ET`);
        console.log(`      📈 HOD Calculation: Prev day after-hours=$${afterHoursHigh.toFixed(2)}, Today max=$${todayMaxHigh.toFixed(2)} (from ALL ${allBarsForHOD.length} bars), TRUE HOD=$${symbolState.hod.toFixed(2)}`);
        console.log(`      📊 Cumulative Volume: ${(symbolState.cumulativeVolume/1000).toFixed(1)}K (from bars >= ${this.config.marketHours.startTime})`);

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
   * Get previous trading day (handles weekends)
   * Returns date string in YYYY-MM-DD format
   */
  private getPreviousTradingDay(dateString: string): string {
    const [year, month, day] = dateString.split('-').map(Number);
    const date = new Date(year, month - 1, day);

    // Move back one day
    date.setDate(date.getDate() - 1);

    // If it's a weekend, go back to Friday
    if (date.getDay() === 0) { // Sunday
      date.setDate(date.getDate() - 2);
    } else if (date.getDay() === 6) { // Saturday
      date.setDate(date.getDate() - 1);
    }

    const year2 = date.getFullYear();
    const month2 = String(date.getMonth() + 1).padStart(2, '0');
    const day2 = String(date.getDate()).padStart(2, '0');
    return `${year2}-${month2}-${day2}`;
  }

  /**
   * Get after-hours high for previous day (4:00-8:00 PM ET)
   * This ensures HOD includes previous day's extended hours trading
   */
  private async getAfterHoursHigh(symbol: string, date: string): Promise<number> {
    try {
      const url = `https://api.polygon.io/v2/aggs/ticker/${symbol}/range/1/minute/${date}/${date}?adjusted=true&sort=asc&limit=50000&include_extended_hours=true&apikey=${this.apiKey}`;

      const response = await fetch(url);
      if (!response.ok) {
        return 0;
      }

      const data = await response.json();
      if (!data.results || data.results.length === 0) {
        return 0;
      }

      // Filter to after-hours (4:00-8:00 PM ET = 16-20 hours)
      const afterHoursBars = data.results.filter((bar: any) => {
        const barTime = new Date(bar.t);
        const etHour = this.getETHour(barTime);
        return etHour >= 16 && etHour < 20;
      });

      if (afterHoursBars.length === 0) {
        return 0;
      }

      const afterHoursHigh = Math.max(...afterHoursBars.map((bar: any) => bar.h));
      console.log(`      📊 ${symbol} After-hours high (${date} 4-8 PM): $${afterHoursHigh.toFixed(2)} from ${afterHoursBars.length} bars`);
      return afterHoursHigh;

    } catch (error) {
      console.error(`   ⚠️  ${symbol}: Failed to fetch after-hours data for ${date}:`, error);
      return 0;
    }
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

    // Update cumulative volume - CRITICAL for matching REST API
    symbolState.cumulativeVolume += agg.v;

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
    const etComponents = this.getETComponents(candleTime);
    const minutes = etComponents.minute;

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
    // Create ET date object for calculations
    const periodStartMinute = Math.floor(minutes / 5) * 5; // Round down to nearest 5

    // Build the completed period timestamp in ET, then convert back to UTC
    const etDateStr = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(candleTime);
    const [month, day, year] = etDateStr.split('/');

    // Create a date string for the period start in ET timezone
    const completedPeriodET = new Date(`${year}-${month}-${day}T${String(etComponents.hour).padStart(2, '0')}:${String(periodStartMinute).padStart(2, '0')}:00`);
    const completedPeriodTimestamp = completedPeriodET.getTime();
    const completedPeriodStart = periodStartMinute;

    // Check if we already processed this period
    if (completedPeriodTimestamp <= state.lastProcessed5MinBoundary) {
      return; // Already processed
    }

    const completedPeriodEnd = (completedPeriodStart + 4) % 60;
    const completedHour = etComponents.hour;

    console.log(`\n${'⏰'.repeat(40)}`);
    console.log(`⏰ ${symbol} - 5-MIN PERIOD COMPLETED with ${this.formatETTime(candleTime)} candle`);
    console.log(`   ✅ Processing COMPLETED period: ${completedHour}:${String(completedPeriodStart).padStart(2,'0')}-${completedHour}:${String(completedPeriodEnd).padStart(2,'0')}`);
    console.log(`   ⚡ INSTANT ALERT: No delay - processing immediately!`);
    console.log(`${'⏰'.repeat(40)}`);

    // We need 5 consecutive 1-minute candles from the completed period
    // For period 10-14, we need candles at: 10, 11, 12, 13, 14
    const required1MinCandles: MinuteCandle[] = [];

    for (let offset = 0; offset < 5; offset++) {
      const targetMinute = completedPeriodStart + offset;

      const candle = state.minuteCandles.find(c => {
        const cTime = new Date(c.timestamp);
        const cET = this.getETComponents(cTime);
        return cET.minute === targetMinute &&
               Math.abs(cET.hour - completedHour) < 2; // Within same hour or adjacent
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
    const fiveMinCandle = this.aggregate5MinCandle(required1MinCandles, completedPeriodET);

    console.log(`   📊 5m Candle [${completedPeriodStart}:00-${completedPeriodStart + 4}:59]: O:${fiveMinCandle.open.toFixed(2)} H:${fiveMinCandle.high.toFixed(2)} L:${fiveMinCandle.low.toFixed(2)} C:${fiveMinCandle.close.toFixed(2)} V:${fiveMinCandle.volume}`);

    // Mark this boundary as processed
    state.lastProcessed5MinBoundary = completedPeriodTimestamp;

    // Run pattern detection on the 5-minute candle (async - don't await to avoid blocking)
    this.detectPatterns(symbol, state, fiveMinCandle, completedPeriodET)
      .catch(error => {
        console.error(`❌ Error in pattern detection for ${symbol}:`, error);
      });
  }

  /**
   * Aggregate 5 1-minute candles into one 5-minute candle
   */
  private aggregate5MinCandle(candles: MinuteCandle[], periodStartTime: Date): BarData {
    // Sort by timestamp to ensure correct order
    const sorted = candles.sort((a, b) => a.timestamp - b.timestamp);

    // CRITICAL: Use the period START time to match REST API behavior
    // This ensures WebSocket and REST generate identical timestamps for the same periods
    // For 16:30-16:34 period, timestamp will be 16:30:00 (not 16:35:00)
    return {
      timestamp: periodStartTime.getTime(), // Use period start time for consistency with REST
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
  private async detectPatterns(symbol: string, state: SymbolState, candle: BarData, timestamp: Date): Promise<void> {
    console.log(`\n🔍 Running pattern detection for ${symbol} at ${this.formatETTime(timestamp)}...`);

    // FILTER 1: Check if within configured market hours window (match REST behavior)
    // Use proper ET timezone conversion with Intl.DateTimeFormat
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false
    });

    const parts = formatter.formatToParts(timestamp);
    const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0');
    const minute = parseInt(parts.find(p => p.type === 'minute')?.value || '0');
    const etHour = hour + minute / 60;

    const [startHour, startMin] = this.config.marketHours.startTime.split(':').map(Number);
    const [endHour, endMin] = this.config.marketHours.endTime.split(':').map(Number);
    const configStart = startHour + startMin / 60;
    const configEnd = endHour + endMin / 60;

    if (etHour < configStart || etHour >= configEnd) {
      console.log(`   ⏰ FILTERED OUT: ${symbol} at ${this.formatETTime(timestamp)} (ET ${etHour.toFixed(2)} = ${hour}:${minute.toString().padStart(2, '0')}) - outside ${configStart.toFixed(1)}-${configEnd.toFixed(1)} hours - SKIPPING DETECTION`);
      return;
    }

    // FILTER 2: Check cumulative volume meets minimum requirement (match REST behavior)
    if (state.cumulativeVolume < this.config.gapCriteria.minCumulativeVolume) {
      console.log(`   🚫 VOLUME FILTER: ${symbol} at ${this.formatETTime(timestamp)} - cumulative volume ${(state.cumulativeVolume/1000).toFixed(1)}K < ${(this.config.gapCriteria.minCumulativeVolume/1000).toFixed(0)}K required - SKIPPING SIGNAL`);
      return;
    } else {
      console.log(`   ✅ VOLUME PASSED: ${symbol} at ${this.formatETTime(timestamp)} - cumulative volume ${(state.cumulativeVolume/1000).toFixed(1)}K >= ${(this.config.gapCriteria.minCumulativeVolume/1000).toFixed(0)}K required`);
    }

    // CRITICAL FIX: Fetch native 5-minute bars from REST API for reliable history
    // This ensures we have complete historical context even if 1-minute bars have gaps
    const bars5m = await this.build5MinCandleHistory(symbol, timestamp);

    // Add the current candle to the end
    bars5m.push(candle);
    const index = bars5m.length - 1; // Current candle is the last one

    console.log(`   📊 Built history of ${bars5m.length} 5-minute candles for pattern detection`);
    console.log(`   📊 Current candle index: ${index}, timestamp: ${this.formatETTime(timestamp)}`);

    // CRITICAL: Pattern detection needs at least 5 bars (index >= 4)
    if (index < 4) {
      console.error(`   🚨 INSUFFICIENT BARS FOR PATTERN DETECTION!`);
      console.error(`   📊 Index: ${index}, Need: >= 4 (at least 5 total bars)`);
      console.error(`   📊 This will cause pattern detection to return NULL`);
      console.error(`   💡 This is why REST works but WebSocket doesn't - REST has full history!`);
      return; // Don't even try pattern detection
    }

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

    // CRITICAL: Pass CUMULATIVE volume, not single bar volume, to match REST API
    const patterns: (Alert | null)[] = [
      this.detectToppingTail5m.call(this, symbol, barsWithProperties as any, index, state.hod, timestamp, state.cumulativeVolume, state.gapPercent),
      this.detectGreenRunReject.call(this, symbol, barsWithProperties as any, index, state.hod, timestamp, state.cumulativeVolume, state.gapPercent),
    ];

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
   * Build historical 5-minute candles using HYBRID approach
   * CRITICAL: REST API has lag (10-30s), so we use:
   * 1. REST API for older bars (reliable, complete)
   * 2. Our 1-minute buffer for recent bars (real-time, no lag)
   * Returns up to last 20 5-minute candles (for patterns that need history)
   */
  private async build5MinCandleHistory(symbol: string, currentTimestamp: Date): Promise<BarData[]> {
    try {
      const state = this.symbols.get(symbol);
      if (!state) {
        console.log(`   ⚠️  ${symbol}: Symbol state not found`);
        return [];
      }

      // STEP 1: Fetch older bars from REST API (reliable, but has lag)
      const now = new Date();
      const dateString = now.toISOString().split('T')[0];

      const url = `https://api.polygon.io/v2/aggs/ticker/${symbol}/range/5/minute/${dateString}/${dateString}?adjusted=true&sort=asc&limit=50000&include_extended_hours=true&apikey=${this.apiKey}`;

      const response = await fetch(url);
      const data = await response.json();

      let olderBars: BarData[] = [];

      if (data.results && data.results.length > 0) {
        // Get ALL bars from REST API initially
        olderBars = data.results.map((bar: any) => ({
          timestamp: bar.t,
          open: bar.o,
          high: bar.h,
          low: bar.l,
          close: bar.c,
          volume: bar.v
        }));

        console.log(`   📊 Fetched ${olderBars.length} 5-minute bars from REST API`);
      }

      // STEP 2: Build recent bars from our 1-minute buffer (real-time, no lag)
      const recentBars = this.buildRecent5MinBarsFromBuffer(state, currentTimestamp);
      console.log(`   📊 Built ${recentBars.length} recent 5-minute bars from 1-minute buffer`);

      // STEP 3: Combine, deduplicate, and return last 20 bars
      // Merge bars from both sources, with buffer bars taking precedence for the same timestamps
      const barMap = new Map<number, BarData>();

      // Add REST API bars first
      olderBars.forEach(bar => {
        barMap.set(bar.timestamp, bar);
      });

      // Overwrite with buffer bars (more accurate, real-time)
      recentBars.forEach(bar => {
        barMap.set(bar.timestamp, bar);
      });

      // Sort by timestamp and take last 20
      const allBars = Array.from(barMap.values()).sort((a, b) => a.timestamp - b.timestamp);
      const history = allBars.slice(-20);

      console.log(`   📊 Total history: ${history.length} bars (${olderBars.length} REST + ${recentBars.length} buffer = ${barMap.size} unique, using last 20)`);

      // CRITICAL: Check if we have enough bars for pattern detection
      if (history.length < 5) {
        console.error(`   🚨 INSUFFICIENT HISTORY: Only ${history.length} bars available, need at least 5 for pattern detection!`);
        console.error(`   📊 REST API bars: ${olderBars.length}, Buffer bars: ${recentBars.length}`);
        console.error(`   🔍 Buffer has ${state.minuteCandles.length} 1-minute candles`);

        // FALLBACK: If REST+Buffer didn't give us enough, try building MORE from buffer with relaxed rules
        if (history.length < 5 && state.minuteCandles.length >= 20) {
          console.log(`   🔄 FALLBACK: Attempting to build more bars from 1-minute buffer with relaxed rules...`);
          const fallbackBars = this.buildMoreBarsFromBuffer(state, currentTimestamp, 20);
          console.log(`   📊 Fallback built ${fallbackBars.length} additional bars`);

          // Merge with existing bars
          fallbackBars.forEach(bar => barMap.set(bar.timestamp, bar));
          const mergedBars = Array.from(barMap.values()).sort((a, b) => a.timestamp - b.timestamp);
          const fallbackHistory = mergedBars.slice(-20);

          console.log(`   📊 After fallback: ${fallbackHistory.length} total bars`);
          return fallbackHistory;
        }
      }

      return history;

    } catch (error) {
      console.error(`   ❌ Failed to build 5-minute history for ${symbol}:`, error);
      return [];
    }
  }

  /**
   * FALLBACK: Build as many bars as possible from buffer with very relaxed rules
   * Used when REST API + normal buffer building didn't provide enough bars
   */
  private buildMoreBarsFromBuffer(state: SymbolState, currentTimestamp: Date, targetCount: number): BarData[] {
    const bars: BarData[] = [];

    if (state.minuteCandles.length < 10) {
      return bars; // Need at least 10 candles
    }

    // Sort candles by timestamp
    const sortedCandles = [...state.minuteCandles].sort((a, b) => a.timestamp - b.timestamp);

    // Try to build 5-minute bars by grouping every 5 consecutive candles
    for (let i = 0; i <= sortedCandles.length - 5; i++) {
      const fiveCandles = sortedCandles.slice(i, i + 5);

      // Check if these 5 candles are reasonably close together (within 10 minutes)
      const timeSpan = fiveCandles[4].timestamp - fiveCandles[0].timestamp;
      if (timeSpan > 10 * 60 * 1000) {
        continue; // Skip if candles are too far apart
      }

      // Determine the period start time from the first candle
      const firstCandleTime = new Date(fiveCandles[0].timestamp);
      const etComponents = this.getETComponents(firstCandleTime);
      const periodStart = Math.floor(etComponents.minute / 5) * 5;

      // Create period time
      const etDateStr = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).format(firstCandleTime);
      const [month, day, year] = etDateStr.split('/');
      const periodTime = new Date(`${year}-${month}-${day}T${String(etComponents.hour).padStart(2, '0')}:${String(periodStart).padStart(2, '0')}:00`);

      // Build the 5-minute bar
      bars.push({
        timestamp: periodTime.getTime(),
        open: fiveCandles[0].open,
        high: Math.max(...fiveCandles.map(c => c.high)),
        low: Math.min(...fiveCandles.map(c => c.low)),
        close: fiveCandles[4].close,
        volume: fiveCandles.reduce((sum, c) => sum + c.volume, 0)
      });

      if (bars.length >= targetCount) {
        break; // Stop if we have enough
      }

      // Skip ahead by 4 to get non-overlapping periods (will increment by 1 in loop)
      i += 4;
    }

    return bars;
  }

  /**
   * Build recent 5-minute bars from 1-minute buffer
   * This provides real-time data without waiting for REST API to publish
   */
  private buildRecent5MinBarsFromBuffer(state: SymbolState, currentTimestamp: Date): BarData[] {
    const recentBars: BarData[] = [];

    if (state.minuteCandles.length === 0) {
      console.log(`   ⚠️  No 1-minute candles in buffer for building 5-minute bars`);
      return recentBars;
    }

    // Get ET time for the current timestamp
    const etComponents = this.getETComponents(currentTimestamp);
    const currentMinute = etComponents.minute;
    const currentHour = etComponents.hour;
    const currentPeriodStart = Math.floor(currentMinute / 5) * 5;

    // Build as many 5-minute bars as possible from our buffer
    // Try to go back far enough to overlap with REST API data
    // Look back up to 2 hours (24 periods) to ensure good coverage
    const maxPeriodsBack = Math.min(24, Math.floor(state.minuteCandles.length / 5));

    console.log(`   🔨 Building 5-min bars from buffer: ${state.minuteCandles.length} 1-min candles available, trying up to ${maxPeriodsBack} periods`);

    // Get date string for building ET timestamps
    const etDateStr = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(currentTimestamp);
    const [month, day, year] = etDateStr.split('/');

    for (let periodsBack = maxPeriodsBack; periodsBack > 0; periodsBack--) {
      // Calculate the period start time, handling hour boundaries
      const targetPeriodStart = currentPeriodStart - (periodsBack * 5);
      const targetHour = targetPeriodStart < 0 ? currentHour - 1 : currentHour;
      const targetMinute = targetPeriodStart < 0 ? 60 + targetPeriodStart : targetPeriodStart;

      const periodTime = new Date(`${year}-${month}-${day}T${String(targetHour).padStart(2, '0')}:${String(targetMinute).padStart(2, '0')}:00`);

      // Collect the 5 1-minute candles for this period
      const fiveMinCandles: MinuteCandle[] = [];

      for (let offset = 0; offset < 5; offset++) {
        const targetMinute = targetPeriodStart + offset;
        const targetTime = new Date(periodTime);
        targetTime.setMinutes(targetMinute);
        const targetTimestamp = targetTime.getTime();

        // Find the candle that matches this minute
        // Use a wider tolerance window to handle timing variations
        const candle = state.minuteCandles.find(c => {
          return Math.abs(c.timestamp - targetTimestamp) < 180000; // Within 3 minutes tolerance
        });

        if (candle) {
          fiveMinCandles.push(candle);
        }
      }

      // Add if we have all 5 candles, or at least 4 (allow 1 missing for tolerance)
      if (fiveMinCandles.length >= 4) {
        if (fiveMinCandles.length < 5) {
          console.log(`   ⚠️  Built 5-min bar with only ${fiveMinCandles.length}/5 candles at ${this.formatETTime(periodTime)}`);
        }
        recentBars.push(this.aggregate5MinCandle(fiveMinCandles, periodTime));
      }
    }

    console.log(`   ✅ Built ${recentBars.length} 5-minute bars from 1-minute buffer`);
    return recentBars;
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
  async updateSymbols(symbolsData: Array<{ symbol: string; gapPercent: number; previousClose: number; currentPrice: number; hod?: number }>): Promise<void> {
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
        const initialHOD = data.hod !== undefined ? data.hod : data.currentPrice;
        this.symbols.set(data.symbol, {
          symbol: data.symbol,
          minuteCandles: [],
          hod: initialHOD,
          gapPercent: data.gapPercent,
          previousClose: data.previousClose,
          lastProcessed5MinBoundary: 0,
          cumulativeVolume: 0
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
   * Get ET hour from a Date (with proper timezone conversion)
   */
  private getETHour(date: Date): number {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false
    });

    const parts = formatter.formatToParts(date);
    const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0');
    const minute = parseInt(parts.find(p => p.type === 'minute')?.value || '0');
    return hour + minute / 60;
  }

  /**
   * Get ET components from a Date (with proper timezone conversion)
   */
  private getETComponents(date: Date): { hour: number; minute: number } {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false
    });

    const parts = formatter.formatToParts(date);
    const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0');
    const minute = parseInt(parts.find(p => p.type === 'minute')?.value || '0');
    return { hour, minute };
  }

  /**
   * Format time in ET
   */
  private formatETTime(date: Date): string {
    return date.toLocaleTimeString('en-US', {
      timeZone: 'America/New_York',
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }
}
