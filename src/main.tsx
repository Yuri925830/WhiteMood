import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { useWhiteMood } from './core/useWhiteMood';
import './styles.css';

function WhiteMood() { const model = useWhiteMood(); return <App model={model} />; }
createRoot(document.getElementById('root')!).render(<StrictMode><WhiteMood /></StrictMode>);
