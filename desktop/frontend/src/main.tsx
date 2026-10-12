import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { AuthGate } from './components/AuthGate'
import { PrivateStorageGate } from './components/PrivateStorageGate'
import './index.css'
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><AuthGate><PrivateStorageGate><App /></PrivateStorageGate></AuthGate></React.StrictMode>
)
