import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { audioEngine } from './audio/AudioEngine.ts';
import './styles.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);

window.addEventListener('pagehide', (event) => {
  if (!event.persisted) audioEngine.dispose();
});
if (import.meta.hot) import.meta.hot.dispose(() => audioEngine.dispose());
