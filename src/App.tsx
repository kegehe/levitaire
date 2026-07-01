import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import FloatingToolbar from "./components/FloatingToolbar";
import FloatingOrb from "./components/FloatingOrb";
import Settings from "./components/Settings";

function App() {
  const windowLabel = getCurrentWebviewWindow().label;

  if (windowLabel === "toolbar") {
    return <FloatingToolbar />;
  }

  if (windowLabel === "orb") {
    return <FloatingOrb />;
  }

  return <Settings />;
}

export default App;
