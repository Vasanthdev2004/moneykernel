import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { UiProvider } from "./components/ui.tsx";
import { ThemeProvider } from "./theme.tsx";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("root element missing");
createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <UiProvider>
        <App />
      </UiProvider>
    </ThemeProvider>
  </StrictMode>,
);
