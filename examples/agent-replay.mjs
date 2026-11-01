// Record a small tool-using agent, verify the trace offline, then replay it.
//   IDEMCORE_API_KEY=... node examples/agent-replay.mjs record run.trace.json
//   npx idemcore-trace verify run.trace.json
//   IDEMCORE_API_KEY=... node examples/agent-replay.mjs replay run.trace.json
import { readFileSync, writeFileSync } from "node:fs";
import { Idemcore, Session, replay, dumpsTrace } from "@idemcore/sdk";

// A real tool would call a weather API; replay feeds the recorded result instead of calling it again.
const getWeather = ({ city }) => ({ city, temp_c: 18, sky: "light rain" });

async function agent(s) {
  const q = [{ role: "system", content: "Answer with one city name only." },
    { role: "user", content: "Which city is the Eiffel Tower in?" }];
  const city = (await s.chat(q, { maxTokens: 8 })).text.trim().replace(/\.$/, "");
  const w = await s.tool("get_weather", { city }, getWeather);
  return (await s.chat([{ role: "user", content: `Weather data: ${JSON.stringify(w)}. Write a one-sentence forecast.` }], { maxTokens: 40 })).text;
}

const [cmd, path] = process.argv.slice(2);
const client = new Idemcore();
if (cmd === "record") {
  const s = new Session(client, { meta: { example: "agent-replay" } });
  console.log(await agent(s));
  writeFileSync(path, dumpsTrace(await s.finish()));
  console.log("saved", path);
} else {
  const r = await replay(JSON.parse(readFileSync(path, "utf8")), client, { agent });
  console.log(r.summary());
  process.exit(r.ok ? 0 : 1);
}
