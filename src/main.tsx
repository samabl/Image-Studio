import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

// 刻意不套 StrictMode：开发环境下 effect 会跑两次，
// 会导致对话流被订阅两遍、bootstrap 重复执行。
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
