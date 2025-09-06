/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {LitElement, css, html} from 'lit';
import {customElement, property} from 'lit/decorators.js';
import {Analyser} from './analyser';

/**
 * simple 2d circle visual for ai speech
 */
@customElement('gdm-live-audio-visuals-simple')
export class GdmLiveAudioVisualsSimple extends LitElement {
  private inputAnalyser!: Analyser;
  private outputAnalyser!: Analyser;
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private animationId!: number;

  private _outputNode!: AudioNode;

  @property()
  set outputNode(node: AudioNode) {
    this._outputNode = node;
    // only create analyser if node exists and has context
    if (node && node.context) {
      this.outputAnalyser = new Analyser(this._outputNode);
      this.tryInitialize();
    }
  }

  get outputNode() {
    return this._outputNode;
  }

  private _inputNode!: AudioNode;

  @property()
  set inputNode(node: AudioNode) {
    this._inputNode = node;
    // only create analyser if node exists and has context
    if (node && node.context) {
      this.inputAnalyser = new Analyser(this._inputNode);
      this.tryInitialize();
    }
  }

  get inputNode() {
    return this._inputNode;
  }

  static styles = css`
    canvas {
      width: 100% !important;
      height: 100% !important;
      position: absolute;
      inset: 0;
    }
  `;

  connectedCallback() {
    super.connectedCallback();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
    }
  }

  private tryInitialize() {
    // init when canvas is ready and at least one analyser exists
    if (this.canvas && (this.inputAnalyser || this.outputAnalyser) && !this.ctx) {
      this.init();
    }
  }

  private init() {
    this.ctx = this.canvas.getContext('2d')!;
    this.resizeCanvas();
    
    window.addEventListener('resize', () => this.resizeCanvas());
    
    this.animate();
  }

  private resizeCanvas() {
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = rect.width * window.devicePixelRatio;
    this.canvas.height = rect.height * window.devicePixelRatio;
    this.ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
  }

  private animate() {
    this.animationId = requestAnimationFrame(() => this.animate());

    // update analysers
    if (this.inputAnalyser) {
      this.inputAnalyser.update();
    }
    if (this.outputAnalyser) {
      this.outputAnalyser.update();
    }

    // clear canvas
    const rect = this.canvas.getBoundingClientRect();
    this.ctx.clearRect(0, 0, rect.width, rect.height);

    // center point
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;

    // calc circle props based on audio output (ai talking)
    const audioLevel = this.outputAnalyser ? this.outputAnalyser.data[0] / 255 : 0;
    const baseRadius = 50;
    const radius = baseRadius + (audioLevel * 100); // grow when ai talks
    
    // pulsing effect
    const pulseIntensity = this.outputAnalyser ? this.outputAnalyser.data[1] / 255 : 0;
    const opacity = 0.3 + (pulseIntensity * 0.7);

    // draw main circle
    this.ctx.beginPath();
    this.ctx.arc(centerX, centerY, radius, 0, 2 * Math.PI);
    this.ctx.fillStyle = `rgba(255, 100, 150, ${opacity})`;
    this.ctx.fill();

    // draw outer ring when ai is talking
    if (audioLevel > 0.1) {
      this.ctx.beginPath();
      this.ctx.arc(centerX, centerY, radius + 20, 0, 2 * Math.PI);
      this.ctx.strokeStyle = `rgba(255, 150, 200, ${opacity * 0.5})`;
      this.ctx.lineWidth = 3;
      this.ctx.stroke();
    }

    // small inner circle for input (user talking)
    const inputLevel = this.inputAnalyser ? this.inputAnalyser.data[0] / 255 : 0;
    if (inputLevel > 0.1) {
      const innerRadius = 20 + (inputLevel * 30);
      this.ctx.beginPath();
      this.ctx.arc(centerX, centerY, innerRadius, 0, 2 * Math.PI);
      this.ctx.fillStyle = `rgba(100, 200, 255, ${inputLevel})`;
      this.ctx.fill();
    }
  }

  protected firstUpdated() {
    this.canvas = this.shadowRoot!.querySelector('canvas') as HTMLCanvasElement;
    this.tryInitialize();
  }

  protected render() {
    return html`<canvas></canvas>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'gdm-live-audio-visuals-simple': GdmLiveAudioVisualsSimple;
  }
}
