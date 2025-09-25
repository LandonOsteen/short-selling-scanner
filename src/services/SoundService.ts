/**
 * Sound Service for Live Trading Alerts
 * Provides audio notifications for trading signals
 */

export interface SoundOption {
  id: string;
  name: string;
  description: string;
  frequency?: number; // For generated tones
  duration?: number;  // In milliseconds
  pattern?: number[]; // For custom patterns [freq1, duration1, freq2, duration2, ...]
}

export const SOUND_OPTIONS: SoundOption[] = [
  {
    id: 'none',
    name: 'No Sound',
    description: 'Silent notifications only'
  },
  {
    id: 'beep',
    name: 'Classic Beep',
    description: 'Simple notification beep',
    frequency: 800,
    duration: 200
  },
  {
    id: 'chime',
    name: 'Gentle Chime',
    description: 'Soft notification chime',
    frequency: 523.25, // C5 note
    duration: 400
  },
  {
    id: 'alert',
    name: 'Alert Tone',
    description: 'Attention-grabbing alert',
    frequency: 1000,
    duration: 300
  },
  {
    id: 'urgent',
    name: 'Urgent Alert',
    description: 'High priority signal',
    pattern: [1200, 150, 0, 50, 1200, 150, 0, 50, 1200, 150]
  },
  {
    id: 'trading-bell',
    name: 'Trading Bell',
    description: 'Classic trading floor bell',
    frequency: 659.25, // E5 note
    duration: 600
  },
  {
    id: 'success',
    name: 'Success Tone',
    description: 'Pleasant success notification',
    pattern: [523.25, 200, 659.25, 200, 783.99, 400] // C-E-G chord progression
  },
  {
    id: 'warning',
    name: 'Warning Sound',
    description: 'Cautionary alert tone',
    pattern: [750, 200, 0, 100, 750, 200]
  }
];

export class SoundService {
  private audioContext: AudioContext | null = null;
  private enabled: boolean = false;

  constructor() {
    this.initializeAudioContext();
  }

  private initializeAudioContext(): void {
    try {
      // Create AudioContext on user interaction to comply with browser policies
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    } catch (error) {
      console.warn('AudioContext not supported:', error);
    }
  }

  public async enableAudio(): Promise<void> {
    if (!this.audioContext) {
      this.initializeAudioContext();
    }

    if (this.audioContext && this.audioContext.state === 'suspended') {
      try {
        await this.audioContext.resume();
        this.enabled = true;
        console.log('Audio enabled for trading alerts');
      } catch (error) {
        console.error('Failed to enable audio:', error);
      }
    } else if (this.audioContext) {
      this.enabled = true;
    }
  }

  public disableAudio(): void {
    this.enabled = false;
  }

  public isEnabled(): boolean {
    return this.enabled && this.audioContext !== null;
  }

  public async playSound(soundId: string): Promise<void> {
    if (!this.enabled || !this.audioContext) {
      return;
    }

    const soundOption = SOUND_OPTIONS.find(option => option.id === soundId);
    if (!soundOption || soundId === 'none') {
      return;
    }

    try {
      if (soundOption.pattern) {
        await this.playPattern(soundOption.pattern);
      } else if (soundOption.frequency && soundOption.duration) {
        await this.playTone(soundOption.frequency, soundOption.duration);
      }
    } catch (error) {
      console.error('Failed to play sound:', error);
    }
  }

  private async playTone(frequency: number, duration: number): Promise<void> {
    if (!this.audioContext) return;

    const oscillator = this.audioContext.createOscillator();
    const gainNode = this.audioContext.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(this.audioContext.destination);

    oscillator.frequency.setValueAtTime(frequency, this.audioContext.currentTime);
    oscillator.type = 'sine';

    // Envelope for smoother sound
    const now = this.audioContext.currentTime;
    gainNode.gain.setValueAtTime(0, now);
    gainNode.gain.linearRampToValueAtTime(0.3, now + 0.01);
    gainNode.gain.exponentialRampToValueAtTime(0.001, now + duration / 1000);

    oscillator.start(now);
    oscillator.stop(now + duration / 1000);

    return new Promise(resolve => {
      oscillator.onended = () => resolve();
    });
  }

  private async playPattern(pattern: number[]): Promise<void> {
    for (let i = 0; i < pattern.length; i += 2) {
      const frequency = pattern[i];
      const duration = pattern[i + 1];

      if (frequency > 0) {
        await this.playTone(frequency, duration);
      } else {
        // Silence
        await new Promise(resolve => setTimeout(resolve, duration));
      }
    }
  }

  public async previewSound(soundId: string): Promise<void> {
    const wasEnabled = this.enabled;
    if (!wasEnabled) {
      await this.enableAudio();
    }

    await this.playSound(soundId);

    if (!wasEnabled) {
      this.disableAudio();
    }
  }

  public getSoundOptions(): SoundOption[] {
    return SOUND_OPTIONS;
  }
}

// Singleton instance
export const soundService = new SoundService();