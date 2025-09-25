# 🎯 Pre-Market Short Scanner - React Web Version

A professional web-based pre-market scanner with Trade Ideas-style interface and ANSI terminal aesthetics. Features individual scan windows for each setup type with real-time alerts and pattern detection.

## ✨ Features

### 🎨 **Trade Ideas-Style Interface**
- Individual terminal windows for each scan pattern
- ANSI-style monospace design with color coding
- Priority-based layout (High → Medium → Low priority)
- Responsive grid layout that adapts to screen size

### 📊 **Scanner Windows**
Each pattern gets its own dedicated window:

**🔴 High Priority Setups:**
- **Topping Tail 1m**: 1-minute topping tail ≥50% upper wick + red close
- **Topping Tail 5m**: 5-minute topping tail ≥50% upper wick + red close
- **HOD Break**: Break above HOD then close back under

**🟡 Medium Priority Setups:**
- **New Low Near HOD**: New 1-minute low near pre-market HOD level
- **EMA200 Reject**: Break above and close below 200 EMA daily resistance

**🟢 Pattern Setups:**
- **Double/Triple Top**: Multiple touches at key level with rejection
- **4+ Green→Red**: 4+ green 1-minute candles then red close

### 💻 **Terminal Aesthetics**
- macOS-style window controls (red/yellow/green dots)
- Monospace fonts with terminal cursor animations
- Real-time scrolling alerts with timestamps
- Color-coded severity indicators
- Pattern descriptions in each window

### 📈 **Real-Time Features**
- Live connection status indicator
- Market phase detection (Pre-Market, Open, After Hours)
- Symbol ticker scrolling in status bar
- Auto-scrolling alert feeds
- Historical vs. live alert distinction

## 🚀 Quick Start

### Prerequisites
- Node.js 18+ installed
- npm or yarn package manager

### Installation & Setup
```bash
# Navigate to the project directory
cd premarket-scanner-web

# Install dependencies
npm install

# Start development server
npm start
```

The application will open at `http://localhost:3000`

### Development Mode
- **Live Reload**: Changes auto-refresh the browser
- **Mock Data**: Simulates alerts every 10 seconds for demo
- **Responsive**: Test on different screen sizes

## 📱 Responsive Design

### Desktop (1600px+)
- 4+ columns of scanner windows
- Full feature set with all panels visible
- Optimal for multiple monitors

### Laptop (1200-1600px)
- 3 columns of scanner windows
- Compact header stats
- Maintained functionality

### Tablet (768-1200px)
- 2 columns or single column layout
- Stacked header information
- Touch-friendly interface

### Mobile (768px and below)
- Single column stack layout
- Collapsible header stats
- Optimized for portrait viewing

## 🎮 Usage

### Navigation
- **Focus**: Click on any scanner window to focus
- **Scroll**: Mouse wheel or touch scroll within windows
- **Responsive**: Automatically adapts to screen size

### Alert Types
- **Live Alerts**: Real-time pattern detections (green border)
- **Historical Alerts**: Backfilled patterns marked as "HIST"
- **Priority Colors**: Red (High), Yellow (Medium), Green (Low)

### Status Information
- **Connection**: Live data feed status
- **Market Phase**: Current market session
- **Statistics**: Alert counts and active symbols
- **Uptime**: Scanner running duration

## 🔧 Customization

### Pattern Configuration
Edit `src/App.tsx` PATTERN_CONFIGS to modify:
- Window titles and colors
- Priority levels (1=High, 2=Medium, 3=Low)
- Display order

### Styling
- **Main Layout**: `src/App.css`
- **Scanner Windows**: `src/components/ScannerWindow.css`
- **Status Bar**: `src/components/StatusBar.css`

### Mock Data
For development, alerts are simulated in `src/App.tsx`. Replace with real WebSocket connection for production.

## 🏗️ Architecture

```
src/
├── App.tsx                 # Main application with pattern configs
├── App.css                 # Trade Ideas-style grid layout
├── types.ts                # TypeScript type definitions
└── components/
    ├── ScannerWindow.tsx   # Individual pattern scanner window
    ├── ScannerWindow.css   # Terminal-style window aesthetics
    ├── StatusBar.tsx       # Bottom status bar component
    └── StatusBar.css       # Status bar styling
```

## 🔌 Integration

### WebSocket Connection (Future)
Replace mock data with real-time connection to:
- Original Node.js scanner backend
- Polygon API WebSocket feeds
- Custom pattern detection engine

### Backend API (Future)
- `/api/alerts` - Historical alert data
- `/api/symbols` - Active symbol list
- `/ws/live` - Real-time alert stream

## 🚀 Production Deployment

```bash
# Build for production
npm run build

# Deploy /build folder to web server
# Serve static files with any web server
```

## 📄 License

MIT License - See original scanner project for details.

---

*Built with React 18, TypeScript, and CSS Grid for a modern, responsive trading interface.*
# short-selling-scanner
