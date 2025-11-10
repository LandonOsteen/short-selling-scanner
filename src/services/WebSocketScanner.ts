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

  constructor(
    apiKey: string,
    config: ScannerConfig,
    patternDetectors: {
      detectToppingTail5m: any;
    }
  ) {
    this.apiKey = apiKey;
    this.config = config;
    this.detectToppingTail5m = patternDetectors.detectToppingTail5m;

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
    const etNow = new Date(now.toLocaleString("en-US", {timeZone: "America/New_York"}));
    const [startHour, startMin] = this.config.marketHours.startTime.split(':').map(Number);

    // Create market start time in ET today
    const marketStartET = new Date(etNow.getFullYear(), etNow.getMonth(), etNow.getDate(), startHour, startMin, 0);

    // Convert ET time to UTC timestamp for filtering
    // This handles DST automatically
    const marketStartUTC = Date.parse(marketStartET.toLocaleString("en-US", {timeZone: "UTC"}));

    // Get today's date string for API
    const dateString = `${etNow.getFullYear()}-${String(etNow.getMonth() + 1).padStart(2, '0')}-${String(etNow.getDate()).padStart(2, '0')}`;

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
        const etTime = new Date(barTime.toLocaleString("en-US", {timeZone: "America/New_York"}));
        const etHour = etTime.getHours() + etTime.getMinutes() / 60;
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
    const fiveMinCandle = this.aggregate5MinCandle(required1MinCandles, completedPeriodTime);

    console.log(`   📊 5m Candle [${completedPeriodStart}:00-${completedPeriodStart + 4}:59]: O:${fiveMinCandle.open.toFixed(2)} H:${fiveMinCandle.high.toFixed(2)} L:${fiveMinCandle.low.toFixed(2)} C:${fiveMinCandle.close.toFixed(2)} V:${fiveMinCandle.volume}`);

    // Mark this boundary as processed
    state.lastProcessed5MinBoundary = completedPeriodTimestamp;

    // Run pattern detection on the 5-minute candle (async - don't await to avoid blocking)
    this.detectPatterns(symbol, state, fiveMinCandle, completedPeriodTime)
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
    const etTime = new Date(timestamp.toLocaleString("en-US", {timeZone: "America/New_York"}));
    const etHour = etTime.getHours() + etTime.getMinutes() / 60;
    const [startHour, startMin] = this.config.marketHours.startTime.split(':').map(Number);
    const [endHour, endMin] = this.config.marketHours.endTime.split(':').map(Number);
    const configStart = startHour + startMin / 60;
    const configEnd = endHour + endMin / 60;

    if (etHour < configStart || etHour >= configEnd) {
      console.log(`   ⏰ FILTERED OUT: ${symbol} at ${this.formatETTime(timestamp)} (ET ${etHour.toFixed(2)}) - outside ${configStart.toFixed(1)}-${configEnd.toFixed(1)} hours - SKIPPING DETECTION`);
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

    console.log(`   📊 Built history of ${bars5m.length} 5-minute candles (${bars5m.length - 1} from REST + 1 current) for pattern detection`);

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
        // Get bars from REST API, but exclude the most recent 3 periods (15 minutes)
        // These might not be published yet due to API lag
        const cutoffTime = currentTimestamp.getTime() - (15 * 60 * 1000); // 15 minutes ago

        olderBars = data.results
          .filter((bar: any) => bar.t < cutoffTime)
          .map((bar: any) => ({
            timestamp: bar.t,
            open: bar.o,
            high: bar.h,
            low: bar.l,
            close: bar.c,
            volume: bar.v
          }));

        console.log(`   📊 Fetched ${olderBars.length} older 5-minute bars from REST API (before ${new Date(cutoffTime).toLocaleTimeString()})`);
      }

      // STEP 2: Build recent bars from our 1-minute buffer (real-time, no lag)
      const recentBars = this.buildRecent5MinBarsFromBuffer(state, currentTimestamp);
      console.log(`   📊 Built ${recentBars.length} recent 5-minute bars from 1-minute buffer`);

      // STEP 3: Combine and return last 20 bars
      const allBars = [...olderBars, ...recentBars];
      const history = allBars.slice(-20);

      console.log(`   📊 Total history: ${history.length} bars (${olderBars.length} from REST + ${recentBars.length} from buffer)`);

      return history;

    } catch (error) {
      console.error(`   ❌ Failed to build 5-minute history for ${symbol}:`, error);
      return [];
    }
  }

  /**
   * Build recent 5-minute bars from 1-minute buffer
   * This avoids REST API lag for the most recent periods
   */
  private buildRecent5MinBarsFromBuffer(state: SymbolState, currentTimestamp: Date): BarData[] {
    const recentBars: BarData[] = [];

    // Get ET time for the current timestamp
    const etTime = new Date(currentTimestamp.toLocaleString("en-US", {timeZone: "America/New_York"}));
    const currentMinute = etTime.getMinutes();
    const currentPeriodStart = Math.floor(currentMinute / 5) * 5;

    // Build up to 4 recent 5-minute candles (20 minutes of recent history)
    // Go backwards from the period before the current one
    for (let periodsBack = 4; periodsBack > 0; periodsBack--) {
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
        recentBars.push(this.aggregate5MinCandle(fiveMinCandles, periodTime));
      }
    }

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
