
// 5331 Phase-E: LiveAsRealtimeSocket translation tests (no network — fake inner WS).
import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import ts from "typescript";
import path from "node:path";

const ROOT = "/home/hermes/themis-voicebot";

// Transpile the adapter with the project compiler + stub the ws module.
const src = readFileSync(path.join(ROOT, "src/ws/live-as-realtime.ts"), "utf8");

class FakeWS {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  readyState = 0;
  sent = [];
  on(ev, cb) { this[`on_${ev}`] = cb; }
  send(s) { this.sent.push(JSON.parse(s)); }
  close() { this.readyState = 3; if (this.on_close) this.on_close(); }
  // test helpers:
  fakeOpen() { this.readyState = 1; if (this.on_open) this.on_open(); }
  fakeMsg(obj) { if (this.on_message) this.on_message(Buffer.from(JSON.stringify(obj))); }
}
// Rebind the module's WebSocket to the fake (the transpiled module captures ws at import time;
// for tests we re-evaluate with a mock cache):
// Simpler: patch via createRequire redirect is overkill — evaluate source with ws swapped:
const stubbed = ts.transpileModule(
  src.replace('from "ws"', 'from "./fake-ws.cjs"'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
).outputText;
writeFileSync(path.join(ROOT, "dist/ws/fake-ws.cjs"), `
class FakeWS { static CONNECTING=0; static OPEN=1; static CLOSING=2; static CLOSED=3;
  constructor(u,o){ this.readyState=0; this.sent=[]; globalThis.__lastFake=this; }
  on(ev,cb){ this["on_"+ev]=cb; }
  send(s){ this.sent.push(JSON.parse(s)); }
  close(){ this.readyState=3; if(this.on_close) this.on_close(); } }
FakeWS.WebSocket = FakeWS;
module.exports = FakeWS; module.exports.default = FakeWS; module.exports.WebSocket = FakeWS;`);
writeFileSync(path.join(ROOT, "dist/ws/live-as-realtime.testbuild2.cjs"), stubbed);
const live = await import(path.join(ROOT, "dist/ws/live-as-realtime.testbuild2.cjs"));
const LiveAsRealtimeSocket = live.LiveAsRealtimeSocket;

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; console.log(`  PASS ${name}`); } else { fail++; console.log(`  FAIL ${name}`); } };

const mk = () => {
  const s = new LiveAsRealtimeSocket({ apiKey: "k", model: "gpt-live-1", sessionConfig: { instructions: "", voice: "ash", tools: [] } });
  const sock = globalThis.__lastFake;
  const out = [];
  s.on("message", (d) => out.push(JSON.parse(d.toString())));
  sock.fakeOpen = () => { sock.readyState = 1; if (sock.on_open) sock.on_open(); };
  sock.fakeMsg = (obj) => { if (sock.on_message) sock.on_message(Buffer.from(JSON.stringify(obj))); };
  sock.fakeOpen();
  return { s, sock, out };
};

// E1: open → session.start sent with pcmu/8000 + ash + gpt-live-1
{
  const { sock } = mk();
  const st = sock.sent.find(m => m.type === "session.start");
  check("E1 session.start sent", !!st);
  check("E1b model", st && st.session.model === "gpt-live-1");
  check("E1c format", st && st.session.audio.format.type === "audio/pcmu" && st.session.audio.format.rate === 8000);
  check("E1d voice", st && st.session.audio.output.voice === "ash");
  check("E1e delegation present", st && st.session.delegation && st.session.delegation.responses.model === "gpt-4o-mini");
  check("E1f delegation.type=responses", st && st.session.delegation.type === "responses");
}
// E2: messages buffered pre-start are flushed after session.started
{
  const { s, sock, out } = mk();
  s.send(JSON.stringify({ type: "input_audio_buffer.append", audio: "XX" }));
  sock.fakeMsg({ type: "session.started", session: { id: "s1" } });
  check("E2 input forwarded post-start", sock.sent.some(m => m.type === "session.input_audio.append" && m.audio === "XX"));
  check("E2b session.updated emitted", out.some(e => e.type === "session.updated"));
}
// E3: output audio + transcript translation
{
  const { sock, out } = mk();
  sock.fakeMsg({ type: "session.output_audio.delta", delta: "AU" });
  check("E3 output_audio.delta", out.some(e => e.type === "response.output_audio.delta" && e.delta === "AU"));
  sock.fakeMsg({ type: "session.input_transcript.delta", delta: "tere" });
  check("E3b input transcript", out.some(e => e.type === "conversation.item.input_audio_transcription.delta" && e.delta === "tere"));
  sock.fakeMsg({ type: "session.output_transcript.delta", delta: "tere" });
  check("E3c output transcript", out.some(e => e.type === "response.output_audio_transcript.delta" && e.delta === "tere"));
}
// E4: function call nested → Realtime-shaped arguments.done
{
  const { sock, out } = mk();
  sock.fakeMsg({ type: "response.output_item.done", item: { type: "function_call", id: "i1", call_id: "c1", name: "end_call", arguments: '{"outcome":"payment_promise"}' } });
  const ev = out.find(e => e.type === "response.function_call_arguments.done");
  check("E4 fn args event", !!ev && ev.name === "end_call" && ev.call_id === "c1");
}
// E5: function_call_output → response.item.create with function_call_output item
{
  const { s, sock } = mk();
  s.send(JSON.stringify({ type: "function_call_output", call_id: "c1", output: "ok" }));
  const ev = sock.sent.find(m => m.type === "response.item.create");
  check("E5 fn output item", ev && ev.item.type === "function_call_output" && ev.item.call_id === "c1");
}
// E6: speed dropped (session.update with speed) with a notice
{
  const { s, sock, out } = mk();
  s.send(JSON.stringify({ type: "session.update", session: { audio: { output: { speed: 1.25 } } } }));
  check("E6 speed not forwarded", !sock.sent.some(m => m.session && m.session.audio && m.session.audio.output && m.session.audio.output.speed !== undefined));
  check("E6b session.updated ack emitted", out.some(e => e.type === "session.updated"));
}
// E7: VAD patches + commit/clear + response.cancel are absorbed
{
  const { s, sock } = mk();
  s.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
  s.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
  s.send(JSON.stringify({ type: "response.cancel" }));
  check("E7 no commit/clear/cancel leaked", !sock.sent.some(m => ["input_audio_buffer.commit","input_audio_buffer.clear","response.cancel"].includes(m.type)));
}
// E8: response.create (greeting) is absorbed — opening lives in session.start instructions;
// session.instructions.append is delegation-side (requires delegation_id) and must NOT be sent.
{
  const { s, sock } = mk();
  s.send(JSON.stringify({ type: "response.create", response: { instructions: "Say EXACTLY: Tere!" } }));
  check("E8 greeting absorbed (no instructions.append)", !sock.sent.some(m => m.type === "session.instructions.append"));
}
// E9: conversation.item.create → response.item.create
{
  const { s, sock } = mk();
  s.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "system", content: "note" } }));
  const ev = sock.sent.find(m => m.type === "response.item.create" && m.item && m.item.role === "system");
  check("E9 system item mapped", !!ev);
}
// E11: turn kick — first input_audio.append post-start triggers one response.create
{
  const { s, sock } = mk();
  sock.fakeMsg({ type: "session.started", session: { id: "s1" } });
  s.send(JSON.stringify({ type: "input_audio_buffer.append", audio: "AA" }));
  const kicks = sock.sent.filter(m => m.type === "response.create");
  check("E11 turn kick on first audio", kicks.length === 1);
  s.send(JSON.stringify({ type: "input_audio_buffer.append", audio: "BB" }));
  check("E11b only one kick", sock.sent.filter(m => m.type === "response.create").length === 1);
  check("E11c both audio forwarded", sock.sent.filter(m => m.type === "session.input_audio.append").length === 2);
}

// E12: no kick before session.started
{
  const s = new LiveAsRealtimeSocket({ apiKey: "k", model: "gpt-live-1", sessionConfig: { instructions: "", voice: "ash", tools: [] } });
  const sock = globalThis.__lastFake;
  // NOT opened yet: send is buffered pre-start; the kick must not fire.
  s.send(JSON.stringify({ type: "input_audio_buffer.append", audio: "CC" }));
  check("E12 no kick pre-start", !sock.sent.some(m => m.type === "response.create"));
}

// E10: session.close → close event + synthesized response.done on session.closed
{
  const { s, sock, out } = mk();
  s.send(JSON.stringify({ type: "session.close" }));
  check("E10 close sent", sock.sent.some(m => m.type === "session.close"));
  sock.fakeMsg({ type: "session.closed", usage: { seconds: 42 }, reason: "close_requested" });
  check("E10b response.done synthesized", out.some(e => e.type === "response.done"));
  check("E10c closed passthrough", out.some(e => e.type === "session.closed" && e.reason === "close_requested"));
}

console.log(`========== PHASE E ADAPTER RESULTS: PASS=${pass} FAIL=${fail} ==========`);
process.exit(fail ? 1 : 0);
