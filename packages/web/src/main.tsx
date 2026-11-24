import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./app.css";

// Glide's cell editor, which it would load on the first key typed (vite.config.ts says why).
// @ts-expect-error: a path Glide doesn't export, aliased in vite.config.ts
void import("glide-overlay-editor");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
