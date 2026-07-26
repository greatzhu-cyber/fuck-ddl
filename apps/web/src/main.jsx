import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import { bootstrapDesktopState } from "./desktop-sqlite.js";
import "./styles.css";

const DESKTOP_BOOTSTRAP_ATTEMPTS = 4;
const DESKTOP_BOOTSTRAP_RETRY_MS = 250;

function waitForDesktopBootstrapRetry() {
  return new Promise((resolve) =>
    window.setTimeout(resolve, DESKTOP_BOOTSTRAP_RETRY_MS),
  );
}

async function bootstrapWithRetry() {
  let lastError = null;
  for (let attempt = 1; attempt <= DESKTOP_BOOTSTRAP_ATTEMPTS; attempt += 1) {
    try {
      return await bootstrapDesktopState();
    } catch (error) {
      lastError = error;
      if (attempt < DESKTOP_BOOTSTRAP_ATTEMPTS) {
        await waitForDesktopBootstrapRetry();
      }
    }
  }
  console.error("Desktop state bootstrap failed after retries", lastError);
  return null;
}

async function start() {
  await bootstrapWithRetry();
  createRoot(document.getElementById("root")).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void start();
