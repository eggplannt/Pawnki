import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { configurePremium } from '@pawnki/shared';
import App from './App';
import './index.css';

configurePremium({ selfHosted: import.meta.env.VITE_SELF_HOSTED === 'true' });

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
