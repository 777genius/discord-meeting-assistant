export const recordingPlaybackStyle = `
:root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; color: #f7f7f8; background: radial-gradient(circle at 20% 0%, #2a2145 0, transparent 36rem), #0b0b0f; }
.shell { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
.card { width: min(720px, 100%); padding: clamp(26px, 5vw, 52px); border: 1px solid #ffffff1c; border-radius: 28px; background: #15151bdb; box-shadow: 0 30px 80px #0008; backdrop-filter: blur(18px); }
.eyebrow { color: #a78bfa; font-size: 12px; font-weight: 800; letter-spacing: .16em; }
h1 { margin: 10px 0 8px; font-size: clamp(32px, 7vw, 56px); line-height: 1; letter-spacing: -.045em; }
.status, .notice { color: #aaaab6; line-height: 1.55; }
.player { display: flex; align-items: center; gap: 20px; margin-top: 34px; padding: 18px; border: 1px solid #ffffff14; border-radius: 20px; background: #0d0d12; }
.player[hidden] { display: none; }
.toggle { width: 58px; height: 58px; flex: 0 0 auto; border: 0; border-radius: 50%; color: #121016; background: #c4b5fd; font-size: 22px; cursor: pointer; transition: transform .15s ease, background .15s ease; }
.toggle:hover { transform: scale(1.04); background: #ddd6fe; }
.toggle:focus-visible, input:focus-visible { outline: 3px solid #a78bfa; outline-offset: 3px; }
.timeline { width: 100%; min-width: 0; display: grid; gap: 2px; }
input[type="range"] {
  --seek-progress: 0%;
  width: 100%; height: 48px; margin: 0;
  appearance: none;
  -webkit-appearance: none;
  background: transparent; cursor: pointer;
  touch-action: none;
}
input[type="range"]::-webkit-slider-runnable-track {
  height: 12px;
  border: 1px solid #ffffff24;
  border-radius: 999px;
  background: linear-gradient(90deg, #8b5cf6 0, #c4b5fd var(--seek-progress), #302d39 var(--seek-progress), #302d39 100%);
  box-shadow: inset 0 1px 2px #0009, 0 0 24px #8b5cf638;
}
input[type="range"]::-webkit-slider-thumb {
  width: 30px;
  height: 30px;
  margin-top: -10px;
  border: 4px solid #17131f;
  border-radius: 50%;
  appearance: none;
  -webkit-appearance: none;
  background: linear-gradient(135deg, #ffffff, #a78bfa 72%);
  box-shadow: 0 0 0 2px #c4b5fd, 0 8px 24px #8b5cf680;
  transition: transform .15s ease, box-shadow .15s ease;
}
input[type="range"]::-moz-range-track {
  height: 12px;
  border: 1px solid #ffffff24;
  border-radius: 999px;
  background: #302d39;
  box-shadow: inset 0 1px 2px #0009, 0 0 24px #8b5cf638;
}
input[type="range"]::-moz-range-progress {
  height: 12px;
  border-radius: 999px;
  background: linear-gradient(90deg, #8b5cf6, #c4b5fd);
}
input[type="range"]::-moz-range-thumb {
  width: 22px;
  height: 22px;
  border: 4px solid #17131f;
  border-radius: 50%;
  background: linear-gradient(135deg, #ffffff, #a78bfa 72%);
  box-shadow: 0 0 0 2px #c4b5fd, 0 8px 24px #8b5cf680;
  transition: transform .15s ease, box-shadow .15s ease;
}
input[type="range"]:hover::-webkit-slider-thumb,
input[type="range"]:focus-visible::-webkit-slider-thumb { transform: scale(1.12); box-shadow: 0 0 0 4px #a78bfa40, 0 10px 30px #8b5cf6a0; }
input[type="range"]:hover::-moz-range-thumb,
input[type="range"]:focus-visible::-moz-range-thumb { transform: scale(1.12); box-shadow: 0 0 0 4px #a78bfa40, 0 10px 30px #8b5cf6a0; }
.times { display: flex; justify-content: space-between; color: #aaaab6; font-variant-numeric: tabular-nums; font-size: 13px; font-weight: 650; letter-spacing: .025em; }
.notice { margin: 18px 2px 0; color: #d8b4fe; }
@media (max-width: 520px) { .card { border-radius: 22px; } .player { gap: 14px; padding: 14px; } .toggle { width: 50px; height: 50px; } }
`;
