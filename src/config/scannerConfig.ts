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

    // Average volume filter (minimum 10-day average volume)
    minAvgVolume: number; // 50000 = 50K shares
  };

  // Pattern Detection Parameters
  patterns: {
    // HOD (High of Day) related patterns
    hod: {
      // Distance from HOD to trigger "Near HOD" signals
      nearHodDistancePercent: number; // 0.5 = 0.5% from HOD

      // Maximum distance from HOD to still be considered "near"
      maxHodDistancePercent: number; // 2.0 = 2% from HOD

      // Minimum time after HOD was set (in minutes)
      minTimeAfterHod: number; // 5 minutes
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

  // Data and Performance Settings
  performance: {
    // Maximum alerts to keep in memory per pattern
    maxAlertsPerPattern: number; // 20

    // Maximum total alerts in memory
    maxTotalAlerts: number; // 100

    // How often to update symbol list (in milliseconds)
    symbolUpdateInterval: number; // 120000 = 2 minutes

    // Debounce delay for symbol updates (in milliseconds)
    symbolUpdateDebounce: number; // 1000 = 1 second
  };

  // API Configuration
  api: {
    // Rate limiting
    maxRequestsPerMinute: number; // 5

    // Retry configuration
    maxRetries: number; // 3
    retryDelay: number; // 1000 = 1 second

    // Timeout for API requests (in milliseconds)
    requestTimeout: number; // 30000 = 30 seconds
  };

  // Development and Testing
  development: {
    // Enable debug logging
    enableDebugLogging: boolean; // true

    // Mock data mode for testing
    useMockData: boolean; // false

    // Override current time for testing (ISO string or null)
    overrideCurrentTime: string | null; // "2024-09-25T14:00:00.000Z"

    // Enable performance monitoring
    enablePerformanceMonitoring: boolean; // true
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
    minGapPercentage: 10.0,
    maxGapPercentage: 10000.0,
    minPrice: 1.0,
    maxPrice: 50.0,
    minCumulativeVolume: 1000000,
    minAvgVolume: 100,
  },

  patterns: {
    hod: {
      nearHodDistancePercent: 1.0, // Tighter range: 0.1% instead of loose range
      maxHodDistancePercent: 10.0, // Maximum 10% from HOD
      minTimeAfterHod: 1, // At least 1 minute after HOD
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

  performance: {
    maxAlertsPerPattern: 20,
    maxTotalAlerts: 100,
    symbolUpdateInterval: 120000,
    symbolUpdateDebounce: 1000,
  },

  api: {
    maxRequestsPerMinute: 5,
    maxRetries: 3,
    retryDelay: 1000,
    requestTimeout: 30000,
  },

  development: {
    enableDebugLogging: true,
    useMockData: false,
    overrideCurrentTime: null,
    enablePerformanceMonitoring: true,
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
  const config = { ...defaultScannerConfig };

  // Example: Override for testing environment
  if (process.env.NODE_ENV === 'development') {
    // Uncomment to test with extended hours
    // config.marketHours.endTime = "16:00"; // 4:00 PM for testing
    // Uncomment to use tighter criteria for testing
    // config.gapCriteria.minGapPercentage = 3.0;
    // config.patterns.hod.nearHodDistancePercent = 0.2;
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
        minTimeAfterHod: 5,
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
        minTimeAfterHod: 1,
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
      enablePerformanceMonitoring: true,
    },
  } as ScannerConfig,
};
