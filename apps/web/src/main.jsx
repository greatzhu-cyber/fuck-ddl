import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import { bootstrapDesktopState } from "./desktop-sqlite.js";
import "./styles.css";

async function start() {
  try {
    await bootstrapDesktopState();
  } catch {
    // A malformed or unavailable desktop database must never prevent startup.
  }
  createRoot(document.getElementById("root")).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void start();
