/**
 * Scanner Configuration
 *
 * This file contains all configurable parameters for the premarket scanner.
 * Adjust these values to fine-tune the scanning behavior and signal detection.
 */

export interface ScannerConfig {
  // Market Hours Configuration
  marketHours: {
    // Scanning timeframe (24-hour format)
    startTime: string; // "04:00" for 4:00 AM
    endTime: string; // "09:30" for 9:30 AM
    timezone: string; // "America/New_York"
  };

  // Gap Stock Filtering Criteria
  gapCriteria: {
    // Minimum gap percentage from previous day's close
    minGapPercentage: number; // 5.0 = 5%

    // Maximum gap percentage (to filter out extreme gaps)
    maxGapPercentage: number; // 50.0 = 50%

    // Price range filtering
    minPrice: number; // $1.00
    maxPrice: number; // $20.00

    // Volume requirements
    minCumulativeVolume: number; // 100000 = 100K shares
  };

  // Pattern Detection Parameters
  patterns: {
    // HOD (High of Day) related patterns
    hod: {
      // Distance from HOD to trigger "Near HOD" signals
      nearHodDistancePercent: number; // 0.5 = 0.5% from HOD

      // Maximum distance from HOD to still be considered "near"
      maxHodDistancePercent: number; // 2.0 = 2% from HOD
    };

    // Topping Tail patterns (1-minute)
    toppingTail: {
      // Minimum upper wick percentage of total candle range
      minUpperWickPercent: number; // 50.0 = 50%

      // Maximum body size as percentage of total range
      maxBodyPercent: number; // 40.0 = 40%

      // Must close red (below open)
      mustCloseRed: boolean; // true

      // Minimum volume per 1-minute bar
      minBarVolume: number; // 5000
    };

    // Green candle run patterns
    greenRun: {
      // Minimum consecutive green candles before red
      minConsecutiveGreen: number; // 4

      // Maximum consecutive green candles to avoid over-extended moves
      maxConsecutiveGreen: number; // 12

      // Minimum total percentage gain during green run
      minRunGainPercent: number; // 2.0 = 2%
    };
  };

  // API Configuration
  api: {
    // Retry configuration
    maxRetries: number; // 3

    // Timeout for API requests (in milliseconds)
    requestTimeout: number; // 30000 = 30 seconds

    // HTTP timeout for individual requests (in milliseconds)
    httpTimeout: number; // 10000 = 10 seconds

    // Polygon API limits
    aggregatesLimit: number; // 50000 = 50K bars per request
  };

  // Scanning Behavior
  scanning: {
    // How often to backfill for new signals (in milliseconds)
    backfillInterval: number; // 30000 = 30 seconds (on :00 and :30)

    // Bid/ask spread for symbol data display
    bidAskSpread: number; // 0.01
  };

  // Historical Analysis
  historical: {
    // Maximum days to look back for historical data
    maxLookbackDays: number; // 730 = ~2 years

    // Number of symbols to analyze in historical scan
    maxSymbolsToAnalyze: number; // 20

    // Minimum volume threshold for symbol discovery
    minVolumeForDiscovery: number; // 50000
  };

  // Development and Testing
  development: {
    // Enable debug logging
    enableDebugLogging: boolean; // true

    // Override current time for testing (ISO string or null)
    overrideCurrentTime: string | null; // "2024-09-25T14:00:00.000Z"
  };
}

/**
 * Default Scanner Configuration
 *
 * These are the default values. You can modify them here or create
 * environment-specific overrides.
 */
export const defaultScannerConfig: ScannerConfig = {
  marketHours: {
    startTime: '04:00',
    endTime: '16:30',
    timezone: 'America/New_York',
  },

  gapCriteria: {
    minGapPercentage: 20.0,
    maxGapPercentage: 10000.0,
    minPrice: 1.0,
    maxPrice: 20.0,
    minCumulativeVolume: 500000,
  },

  patterns: {
    hod: {
      nearHodDistancePercent: 3.0, // Tighter range: 3% instead of loose range
      maxHodDistancePercent: 10.0, // Maximum 10% from HOD
    },

    toppingTail: {
      minUpperWickPercent: 60.0,
      maxBodyPercent: 40.0,
      mustCloseRed: false,
      minBarVolume: 1000, // Lower requirement - rely on cumulative volume filtering
    },

    greenRun: {
      minConsecutiveGreen: 4,
      maxConsecutiveGreen: 12,
      minRunGainPercent: 2.0,
    },
  },

  api: {
    maxRetries: 3,
    requestTimeout: 30000,
    httpTimeout: 10000,
    aggregatesLimit: 50000,
  },

  scanning: {
    backfillInterval: 30000,
    bidAskSpread: 0.01,
  },

  historical: {
    maxLookbackDays: 730,
    maxSymbolsToAnalyze: 20,
    minVolumeForDiscovery: 50000,
  },

  development: {
    enableDebugLogging: true,
    overrideCurrentTime: null,
  },
};

/**
 * Get current scanner configuration
 *
 * This function returns the active configuration, allowing for
 * environment-specific overrides or runtime modifications.
 */
export const getScannerConfig = (): ScannerConfig => {
  // You can add environment-specific overrides here
  let config = { ...defaultScannerConfig };

  // Check for extended hours configuration
  const useExtendedHours = process.env.REACT_APP_USE_EXTENDED_HOURS === 'true';

  if (useExtendedHours) {
    console.log('🕐 Using EXTENDED HOURS configuration (4:00 AM - 4:00 PM ET)');
    config = { ...exampleConfigs.extendedHours };
  }

  // Example: Override for testing environment
  if (process.env.NODE_ENV === 'development') {
    // You can manually override hours here if needed
    // config.marketHours.endTime = "16:00"; // 4:00 PM for testing
    // config.gapCriteria.minGapPercentage = 20.0;
  }

  return config;
};

/**
 * Validation function for scanner configuration
 */
export const validateScannerConfig = (config: ScannerConfig): string[] => {
  const errors: string[] = [];

  // Validate market hours
  const startTime = parseTime(config.marketHours.startTime);
  const endTime = parseTime(config.marketHours.endTime);

  if (startTime === null) {
    errors.push(`Invalid start time format: ${config.marketHours.startTime}`);
  }
  if (endTime === null) {
    errors.push(`Invalid end time format: ${config.marketHours.endTime}`);
  }
  if (startTime && endTime && startTime >= endTime) {
    errors.push('Start time must be before end time');
  }

  // Validate gap criteria
  if (config.gapCriteria.minGapPercentage < 0) {
    errors.push('Minimum gap percentage must be positive');
  }
  if (
    config.gapCriteria.maxGapPercentage <= config.gapCriteria.minGapPercentage
  ) {
    errors.push('Maximum gap percentage must be greater than minimum');
  }
  if (config.gapCriteria.minPrice <= 0) {
    errors.push('Minimum price must be positive');
  }
  if (config.gapCriteria.maxPrice <= config.gapCriteria.minPrice) {
    errors.push('Maximum price must be greater than minimum price');
  }

  // Validate HOD pattern parameters
  if (config.patterns.hod.nearHodDistancePercent < 0) {
    errors.push('Near HOD distance percentage must be positive');
  }
  if (
    config.patterns.hod.maxHodDistancePercent <=
    config.patterns.hod.nearHodDistancePercent
  ) {
    errors.push('Max HOD distance must be greater than near HOD distance');
  }

  return errors;
};

/**
 * Helper function to parse time strings
 */
const parseTime = (timeString: string): number | null => {
  const match = timeString.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;

  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);

  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }

  return hours * 60 + minutes; // Return minutes since midnight
};

/**
 * Example configurations for different scenarios
 */
export const exampleConfigs = {
  // Conservative settings for live trading
  conservative: {
    ...defaultScannerConfig,
    gapCriteria: {
      ...defaultScannerConfig.gapCriteria,
      minGapPercentage: 8.0,
      minPrice: 2.0,
      minCumulativeVolume: 200000,
    },
    patterns: {
      ...defaultScannerConfig.patterns,
      hod: {
        nearHodDistancePercent: 0.2,
        maxHodDistancePercent: 0.8,
      },
    },
  } as ScannerConfig,

  // Aggressive settings for more signals
  aggressive: {
    ...defaultScannerConfig,
    gapCriteria: {
      ...defaultScannerConfig.gapCriteria,
      minGapPercentage: 3.0,
      minPrice: 0.5,
      minCumulativeVolume: 50000,
    },
    patterns: {
      ...defaultScannerConfig.patterns,
      hod: {
        nearHodDistancePercent: 0.5,
        maxHodDistancePercent: 2.0,
      },
    },
  } as ScannerConfig,

  // Testing configuration with extended hours
  testing: {
    ...defaultScannerConfig,
    marketHours: {
      ...defaultScannerConfig.marketHours,
      startTime: '04:00',
      endTime: '16:00', // Extended to 4:00 PM for testing
    },
    development: {
      ...defaultScannerConfig.development,
      enableDebugLogging: true,
    },
  } as ScannerConfig,

  // Extended hours for full day trading (premarket + regular market)
  extendedHours: {
    ...defaultScannerConfig,
    marketHours: {
      ...defaultScannerConfig.marketHours,
      startTime: '04:00', // 4:00 AM ET (premarket start)
      endTime: '16:00', // 4:00 PM ET (market close)
    },
    gapCriteria: {
      ...defaultScannerConfig.gapCriteria,
      minGapPercentage: 20.0,
      minCumulativeVolume: 1000000,
    },
    api: {
      ...defaultScannerConfig.api,
    },
    scanning: {
      ...defaultScannerConfig.scanning,
    },
    historical: {
      ...defaultScannerConfig.historical,
    },
    development: {
      ...defaultScannerConfig.development,
      enableDebugLogging: true,
    },
  } as ScannerConfig,
};
