/* tslint:disable */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleGenAI, LiveServerMessage, Modality, Session} from '@google/genai';
import {LitElement, css, html} from 'lit';
import {customElement, state} from 'lit/decorators.js';
import {createBlob, decode, decodeAudioData} from './utils';
import './visual-simple';

@customElement('gdm-live-audio')
export class GdmLiveAudio extends LitElement {
  @state() isRecording = false;
  @state() status = '';
  @state() error = '';
  @state() conversationState = 'waiting'; // waiting, listening, processing, responding

  private client: GoogleGenAI;
  private session: Session;
  private audioContext: AudioContext | null = null;
  @state() inputNode: GainNode | null = null;
  @state() outputNode: GainNode | null = null;
  private nextStartTime = 0;
  private mediaStream: MediaStream;
  private sourceNode: MediaStreamAudioSourceNode;
  private scriptProcessorNode: ScriptProcessorNode;
  private sources = new Set<AudioBufferSourceNode>();
  
  // vad and audio optimization vars
  private audioBuffer: Float32Array[] = [];
  private silenceThreshold = 0.01; // adj for noise sensitivity 
  private silenceCount = 0;
  private maxSilenceFrames = 30; // ~0.5s of silence at 60fps
  private minAudioFrames = 10; // min audio before sending
  private lastAudioLevel = 0;
  private isProcessingAudio = false;

  // simple linear resampling to 16khz for ai model input
  private resampleTo16kHz(input: Float32Array, inputSampleRate: number): Float32Array {
    const outputSampleRate = 16000;
    
    // if already at target rate, return as-is
    if (inputSampleRate === outputSampleRate) {
      return input;
    }
    
    const ratio = inputSampleRate / outputSampleRate;
    const outputLength = Math.floor(input.length / ratio);
    const output = new Float32Array(outputLength);
    
    for (let i = 0; i < outputLength; i++) {
      const srcIndex = i * ratio;
      const index = Math.floor(srcIndex);
      const fraction = srcIndex - index;
      
      if (index + 1 < input.length) {
        // linear interpolation
        output[i] = input[index] * (1 - fraction) + input[index + 1] * fraction;
      } else {
        output[i] = input[index] || 0;
      }
    }
    
    return output;
  }

  // calc rms audio level for vad
  private calculateAudioLevel(samples: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      sum += samples[i] * samples[i];
    }
    return Math.sqrt(sum / samples.length);
  }

  // detect if audio contains speech vs noise
  private hasVoiceActivity(audioLevel: number): boolean {
    return audioLevel > this.silenceThreshold;
  }

  // send buffered audio chunks efficiently 
  private sendAudioChunk() {
    if (this.audioBuffer.length < this.minAudioFrames || this.isProcessingAudio) {
      return;
    }

    this.isProcessingAudio = true;
    
    // concat all buffered frames
    const totalLength = this.audioBuffer.reduce((sum, chunk) => sum + chunk.length, 0);
    const combinedAudio = new Float32Array(totalLength);
    let offset = 0;
    
    for (const chunk of this.audioBuffer) {
      combinedAudio.set(chunk, offset);
      offset += chunk.length;
    }
    
    // send combined chunk and clear buffer
    this.session.sendRealtimeInput({media: createBlob(combinedAudio)});
    this.audioBuffer = [];
    
    // small delay to prevent overwhelming api
    setTimeout(() => {
      this.isProcessingAudio = false;
    }, 50);
  }

  static styles = css`
    :host {
      display: block;
      width: 100vw;
      height: 100vh;
      position: relative;
      background: #100c14;
    }

    #status {
      position: absolute;
      bottom: 5vh;
      left: 0;
      right: 0;
      z-index: 10;
      text-align: center;
      color: white;
      font-size: 14px;
    }

    .audio-level {
      position: absolute;
      bottom: 15vh;
      left: 50%;
      transform: translateX(-50%);
      width: 200px;
      height: 4px;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 2px;
      overflow: hidden;
      z-index: 10;
    }

    .audio-level-bar {
      height: 100%;
      background: linear-gradient(90deg, #00ff00, #ffff00, #ff0000);
      border-radius: 2px;
      transition: width 0.1s ease;
    }

    .controls {
      z-index: 10;
      position: absolute;
      bottom: 10vh;
      left: 0;
      right: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      gap: 10px;

      button {
        outline: none;
        border: 1px solid rgba(255, 255, 255, 0.2);
        color: white;
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.1);
        width: 64px;
        height: 64px;
        cursor: pointer;
        font-size: 24px;
        padding: 0;
        margin: 0;

        &:hover {
          background: rgba(255, 255, 255, 0.2);
        }
      }

      button[disabled] {
        display: none;
      }
    }

    gdm-live-audio-visuals-simple {
      display: block;
      width: 100%;
      height: 100%;
      position: absolute;
      top: 0;
      left: 0;
    }
  `;

  constructor() {
    super();
    this.initClient();
  }

  private initAudio() {
    // lazy init audio ctx on user gesture to avoid browser restrictions
    if (!this.audioContext) {
      // use system default sample rate to avoid audionode connection issues
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      this.inputNode = this.audioContext.createGain();
      this.outputNode = this.audioContext.createGain();
      this.outputNode.connect(this.audioContext.destination);
    }
    this.nextStartTime = this.audioContext.currentTime;
  }

  private async initClient() {
    // check if api key is loaded
    if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'your_api_key_here') {
      this.updateError('Please set your GEMINI_API_KEY in .env.local file');
      return;
    }

    this.client = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
    });
    
    // note: cookie warnings from google ai api are expected and don't affect functionality

    // dont init session until audio context is ready (user gesture)
  }

  private async initSession() {
    const model = 'gemini-2.5-flash-preview-native-audio-dialog';

    // sys prompt for complaint-focused conv flow
    const systemPrompt = `You are a helpful customer service assistant. Your job is to:

1. First, warmly greet the user and ask them to describe their complaint or issue
2. Once they share their complaint, ask specific follow-up questions to gather more details about ONLY that complaint
3. Ask one question at a time, keeping responses conversational and empathetic
4. Focus your questions on understanding: what happened, when it occurred, what they expected vs what they got, how it affected them, and what resolution they're seeking
5. Stay focused on their specific complaint - don't ask about unrelated topics
6. Keep responses brief and natural, as if you're having a real conversation
7. Show understanding and empathy throughout the conversation
8. IMPORTANT: Respond quickly and concisely. Avoid long pauses or silence.
9. If you detect background noise or unclear audio, ask the user to repeat their last statement

Start by introducing yourself and asking about their complaint.`;

    try {
      this.session = await this.client.live.connect({
        model: model,
        callbacks: {
          onopen: () => {
            this.updateStatus('Ready to listen to your complaint');
            this.conversationState = 'waiting';
          },
          onmessage: async (message: LiveServerMessage) => {
            const audio =
              message.serverContent?.modelTurn?.parts[0]?.inlineData;

            if (audio && this.audioContext && this.outputNode) {
              this.conversationState = 'responding';
              this.updateStatus('Assistant is responding...');
              
              this.nextStartTime = Math.max(
                this.nextStartTime,
                this.audioContext.currentTime,
              );

              const audioBuffer = await decodeAudioData(
                decode(audio.data),
                this.audioContext,
                24000,
                1,
              );
              const source = this.audioContext.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(this.outputNode);
              source.addEventListener('ended', () =>{
                this.sources.delete(source);
                // when resp finishes, ready for next input
                if (this.sources.size === 0) {
                  this.conversationState = 'waiting';
                  this.updateStatus('Listening for your response...');
                }
              });

              source.start(this.nextStartTime);
              this.nextStartTime = this.nextStartTime + audioBuffer.duration;
              this.sources.add(source);
            }

            const interrupted = message.serverContent?.interrupted;
            if(interrupted) {
              for(const source of this.sources.values()) {
                source.stop();
                this.sources.delete(source);
              }
              this.nextStartTime = 0;
            }
          },
          onerror: (e: ErrorEvent) => {
            this.updateError(e.message);
          },
          onclose: (e: CloseEvent) => {
            this.updateStatus('Close:' + e.reason);
          },
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {prebuiltVoiceConfig: {voiceName: 'Orus'}},
            // languageCode: 'en-GB'
          },
          systemInstruction: {
            parts: [{text: systemPrompt}]
          },
        },
      });
    } catch (e) {
      console.error(e);
    }
  }

  private updateStatus(msg: string) {
    this.status = msg;
  }

  private updateError(msg: string) {
    this.error = msg;
  }

  private async startRecording() {
    if (this.isRecording) {
      return;
    }

    // init audio ctx on first user gesture
    this.initAudio();
    
    if (!this.audioContext || !this.inputNode) {
      this.updateError('Audio context not initialized');
      return;
    }

    // init session now that audio ctx is ready
    if (!this.session) {
      await this.initSession();
    }

    await this.audioContext.resume();

    this.updateStatus('Requesting microphone access...');

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });

      this.updateStatus('Microphone access granted. Starting capture...');

      this.sourceNode = this.audioContext.createMediaStreamSource(
        this.mediaStream,
      );
      this.sourceNode.connect(this.inputNode);

      const bufferSize = 256;
      this.scriptProcessorNode = this.audioContext.createScriptProcessor(
        bufferSize,
        1,
        1,
      );

      this.scriptProcessorNode.onaudioprocess = (audioProcessingEvent) => {
        if (!this.isRecording) return;

        const inputBuffer = audioProcessingEvent.inputBuffer;
        const pcmData = inputBuffer.getChannelData(0);
        
        // calc audio level for vad
        const audioLevel = this.calculateAudioLevel(pcmData);
        this.lastAudioLevel = audioLevel;

        // check for voice activity
        if (this.hasVoiceActivity(audioLevel)) {
          this.silenceCount = 0;
          this.conversationState = 'listening';
          this.updateStatus('🔴 Capturing your voice...');
          
          // resample and buffer audio
          const resampledData = this.resampleTo16kHz(pcmData, this.audioContext.sampleRate);
          this.audioBuffer.push(resampledData);
          
          // send chunk if buffer is getting full
          if (this.audioBuffer.length >= 20) { // ~300ms chunks
            this.sendAudioChunk();
          }
        } else {
          this.silenceCount++;
          
          // if we have audio buffered and hit silence, send it
          if (this.audioBuffer.length > 0 && this.silenceCount >= this.maxSilenceFrames) {
            this.sendAudioChunk();
            this.conversationState = 'processing';
            this.updateStatus('Processing your input...');
          }
        }
      };

      this.sourceNode.connect(this.scriptProcessorNode);
      this.scriptProcessorNode.connect(this.audioContext.destination);

      this.isRecording = true;
      this.conversationState = 'listening';
      this.updateStatus('🔴 Listening to your complaint...');
    } catch (err) {
      console.error('Error starting recording:', err);
      this.updateStatus(`Error: ${err.message}`);
      this.stopRecording();
    }
  }

  private stopRecording() {
    if (!this.isRecording && !this.mediaStream && !this.audioContext)
      return;

    this.updateStatus('Stopping recording...');

    this.isRecording = false;

    // send any remaining buffered audio
    if (this.audioBuffer.length > 0) {
      this.sendAudioChunk();
    }

    if (this.scriptProcessorNode && this.sourceNode && this.audioContext) {
      this.scriptProcessorNode.disconnect();
      this.sourceNode.disconnect();
    }

    this.scriptProcessorNode = null;
    this.sourceNode = null;

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    // reset audio processing vars
    this.audioBuffer = [];
    this.silenceCount = 0;
    this.isProcessingAudio = false;
    
    this.conversationState = 'processing';
    this.updateStatus('Processing your input...');
  }

  private reset() {
    this.session?.close();
    
    // reset all audio processing vars
    this.audioBuffer = [];
    this.silenceCount = 0;
    this.isProcessingAudio = false;
    this.lastAudioLevel = 0;
    
    // only reinit session if audio ctx is ready
    if (this.audioContext) {
      this.initSession();
    }
    this.conversationState = 'waiting';
    this.updateStatus('Session cleared. Ready for a new complaint.');
  }

  render() {
    return html`
      <div>
        <div class="controls">
          <button
            id="resetButton"
            @click=${this.reset}
            ?disabled=${this.isRecording}>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              height="40px"
              viewBox="0 -960 960 960"
              width="40px"
              fill="#ffffff">
              <path
                d="M480-160q-134 0-227-93t-93-227q0-134 93-227t227-93q69 0 132 28.5T720-690v-110h80v280H520v-80h168q-32-56-87.5-88T480-720q-100 0-170 70t-70 170q0 100 70 170t170 70q77 0 139-44t87-116h84q-28 106-114 173t-196 67Z" />
            </svg>
          </button>
          <button
            id="startButton"
            @click=${this.startRecording}
            ?disabled=${this.isRecording}>
            <svg
              viewBox="0 0 100 100"
              width="32px"
              height="32px"
              fill="#c80000"
              xmlns="http://www.w3.org/2000/svg">
              <circle cx="50" cy="50" r="50" />
            </svg>
          </button>
          <button
            id="stopButton"
            @click=${this.stopRecording}
            ?disabled=${!this.isRecording}>
            <svg
              viewBox="0 0 100 100"
              width="32px"
              height="32px"
              fill="#000000"
              xmlns="http://www.w3.org/2000/svg">
              <rect x="0" y="0" width="100" height="100" rx="15" />
            </svg>
          </button>
        </div>

        <div class="audio-level" ?hidden=${!this.isRecording}>
          <div class="audio-level-bar" style="width: ${Math.min(this.lastAudioLevel * 1000, 100)}%"></div>
        </div>
        
        <div id="status"> ${this.error} </div>
        <gdm-live-audio-visuals-simple
          .inputNode=${this.inputNode}
          .outputNode=${this.outputNode}></gdm-live-audio-visuals-simple>
      </div>
    `;
  }
}
