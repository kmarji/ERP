import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import './index.css';
import { LangProvider, Shell } from './lib';
import Interview from './pages/Interview';
import Jobs from './pages/Jobs';
import Status from './pages/Status';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LangProvider>
      <BrowserRouter>
        <Shell>
          <Routes>
            <Route path="/status/:token" element={<Status />} />
            <Route path="/interview/:token" element={<Interview />} />
            <Route path="/:tenant" element={<Jobs />} />
            <Route path="/:tenant/:code" element={<Jobs />} />
          </Routes>
        </Shell>
      </BrowserRouter>
    </LangProvider>
  </React.StrictMode>,
);
