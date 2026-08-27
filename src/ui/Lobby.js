import { NetSession } from '../net/NetSession.js';
import { normaliseRoomCode } from '../net/Protocol.js';

/**
 * The very first screen: solo, or connect to a friend first.
 *
 * Plain DOM, unlike the rest of the in-session UI — there is no stereo view
 * yet to worry about matching, this runs before the camera or renderer are
 * even started.
 */
export class Lobby {
  /**
   * @param {(result: {mode: 'solo'} | {mode: 'versus', net: NetSession}) => void} onDone
   */
  constructor(onDone) {
    this.onDone = onDone;
    /** @type {NetSession|null} */
    this.net = null;

    this.dom = {
      root: document.getElementById('lobby'),
      mode: document.getElementById('lobby-mode'),
      versusMode: document.getElementById('lobby-versus-mode'),
      hosting: document.getElementById('lobby-hosting'),
      joining: document.getElementById('lobby-joining'),
      solo: document.getElementById('lobby-solo'),
      versus: document.getElementById('lobby-versus'),
      host: document.getElementById('lobby-host'),
      join: document.getElementById('lobby-join'),
      backMode: document.getElementById('lobby-back-mode'),
      roomCode: document.getElementById('lobby-room-code'),
      hostStatus: document.getElementById('lobby-host-status'),
      cancelHost: document.getElementById('lobby-cancel-host'),
      codeInput: document.getElementById('lobby-code-input'),
      connect: document.getElementById('lobby-connect'),
      joinStatus: document.getElementById('lobby-join-status'),
      cancelJoin: document.getElementById('lobby-cancel-join'),
      error: document.getElementById('lobby-error'),
    };

    this._bind();
  }

  _bind() {
    this.dom.solo.addEventListener('click', () => this._finish({ mode: 'solo' }));
    this.dom.versus.addEventListener('click', () => this._show('versusMode'));
    this.dom.backMode.addEventListener('click', () => this._show('mode'));
    this.dom.host.addEventListener('click', () => this._startHost());
    this.dom.join.addEventListener('click', () => {
      this.dom.codeInput.value = '';
      this.dom.joinStatus.textContent = '';
      this._show('joining');
      this.dom.codeInput.focus();
    });
    this.dom.cancelHost.addEventListener('click', () => this._cancel());
    this.dom.cancelJoin.addEventListener('click', () => this._cancel());
    this.dom.connect.addEventListener('click', () => this._startJoin());
    this.dom.codeInput.addEventListener('input', () => {
      const at = this.dom.codeInput.selectionStart;
      this.dom.codeInput.value = normaliseRoomCode(this.dom.codeInput.value).slice(0, 5);
      this.dom.codeInput.setSelectionRange(at, at);
    });
    this.dom.codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._startJoin();
    });
  }

  _show(section) {
    this.dom.mode.hidden = section !== 'mode';
    this.dom.versusMode.hidden = section !== 'versusMode';
    this.dom.hosting.hidden = section !== 'hosting';
    this.dom.joining.hidden = section !== 'joining';
    this.dom.error.hidden = true;
  }

  _showError(err) {
    this.dom.error.hidden = false;
    this.dom.error.textContent = err?.message || String(err);
  }

  _cancel() {
    this.net?.close();
    this.net = null;
    this._show('versusMode');
  }

  async _startHost() {
    this.net?.close();
    const net = new NetSession();
    this.net = net;
    this._show('hosting');
    this.dom.roomCode.textContent = '…';
    net.onConnected = () => this._finish({ mode: 'versus', net });

    try {
      const code = await net.host((status) => {
        this.dom.hostStatus.textContent = status;
      });
      this.dom.roomCode.textContent = code;
    } catch (err) {
      if (this.net !== net) return; // cancelled while this was in flight
      this._show('versusMode'); // _show() itself clears the error — do this first
      this._showError(err);
    }
  }

  async _startJoin() {
    const code = normaliseRoomCode(this.dom.codeInput.value);
    if (code.length < 4) {
      this.dom.joinStatus.textContent = 'Enter the code your friend was given.';
      return;
    }

    this.net?.close();
    const net = new NetSession();
    this.net = net;
    this.dom.connect.disabled = true;
    net.onConnected = () => this._finish({ mode: 'versus', net });

    try {
      await net.join(code, (status) => {
        this.dom.joinStatus.textContent = status;
      });
    } catch (err) {
      if (this.net !== net) return;
      this.dom.connect.disabled = false;
      this._showError(err);
    }
  }

  _finish(result) {
    if (result.mode === 'versus') {
      // The match is live now; a disconnect from here on is the session's
      // problem to handle, not the lobby's.
      result.net.onConnected = null;
    } else {
      this.net?.close();
      this.net = null;
    }
    this.dom.root.hidden = true;
    this.onDone(result);
  }
}

export default Lobby;
