/* ==========================================================================
   GÊNESIS - VOICE COMMANDS (WEB SPEECH API)
   ========================================================================== */

import { handleSendMessage } from '../agent/chat.js';

let speechRecognizer = null;
let isListening = false;

function getSpeechRecognitionClass() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

export function initVoiceInput() {
  const btn = document.getElementById('btn-voice-input');
  const SpeechRecognitionClass = getSpeechRecognitionClass();

  if (!SpeechRecognitionClass) {
    btn.disabled = true;
    btn.title = 'Comandos de voz não são suportados neste navegador';
    btn.style.opacity = '0.4';
    btn.style.cursor = 'not-allowed';
    return;
  }

  speechRecognizer = new SpeechRecognitionClass();
  speechRecognizer.lang = 'pt-BR';
  speechRecognizer.interimResults = false;
  speechRecognizer.maxAlternatives = 1;

  speechRecognizer.addEventListener('result', (event) => {
    const transcript = event.results[0][0].transcript;
    const input = document.getElementById('chat-input');
    input.value = transcript;
    handleSendMessage(transcript);
    input.value = '';
  });

  speechRecognizer.addEventListener('end', () => {
    isListening = false;
    btn.classList.remove('recording');
  });

  speechRecognizer.addEventListener('error', (event) => {
    isListening = false;
    btn.classList.remove('recording');
    if (event.error !== 'no-speech' && event.error !== 'aborted') {
      console.error('Speech recognition error:', event.error);
    }
  });

  btn.addEventListener('click', () => {
    if (isListening) {
      speechRecognizer.stop();
      return;
    }
    isListening = true;
    btn.classList.add('recording');
    speechRecognizer.start();
  });
}
