# Agent tái lập được: ghi, phát lại, xác minh (JavaScript)

Cùng định dạng trace (`idemcore-trace/r1`) với SDK Python: trace ghi bằng ngôn ngữ
này xác minh và phát lại được bằng ngôn ngữ kia. Đặc tả đầy đủ nằm trong
`docs/agent-replay.md` của SDK Python.

```js
import { Idemcore, Session, replay, verifyTrace, generateSigningKey, dumpsTrace } from "@idemcore/sdk";
import { readFileSync, writeFileSync } from "node:fs";

const client = new Idemcore();           // lấy IDEMCORE_API_KEY từ biến môi trường
const getWeather = ({ city }) => ({ city, temp_c: 18 });

async function agent(s) {
  const city = (await s.chat("Which city is the Eiffel Tower in? One word.", { maxTokens: 8 })).text.trim().replace(/\.$/, "");
  const w = await s.tool("get_weather", { city }, getWeather);   // chạy tool, ghi tham số + kết quả
  return (await s.chat(`Weather: ${JSON.stringify(w)}. One-sentence forecast.`, { maxTokens: 40 })).text;
}

// ghi
const s = new Session(client, { meta: { job: "forecast-demo" } });
await agent(s);
const key = await generateSigningKey();  // JWK bí mật: giữ kín, công bố key.kid
writeFileSync("run.trace.json", dumpsTrace(await s.finish({ signWith: key })));

// xác minh offline (không cần mạng)
const trace = JSON.parse(readFileSync("run.trace.json", "utf8"));
console.log((await verifyTrace(trace, { trustedSigners: [key.kid] })).ok);

// phát lại: lời gọi mô hình được gửi lại và phải giống hệt từng bit; tool KHÔNG chạy lại
console.log((await replay(trace, client, { agent })).summary());
```

* `verifyTrace` báo lỗi nếu có bước bị sửa, xoá, chèn, đổi thứ tự, manifest bị đổi, chữ ký biên nhận không hợp lệ, hoặc prompt / token / văn bản không khớp biên nhận.
* `replay` không có `agent`: chỉ gửi lại các yêu cầu mô hình. Có `agent`: chạy lại mã của bạn, kết quả tool lấy từ trace (an toàn với tool có tác dụng phụ); agent gọi khác đi là bị báo lệch.
* CLI: `npx idemcore-trace verify|show|replay run.trace.json`.

Trace chứng minh: mỗi câu trả lời do Idemcore tạo cho đúng yêu cầu đó, và các bước
không bị sửa sau khi ghi. Kết quả tool là những gì mã của bạn ghi lại; trace không
chứng minh được tool đã thật sự trả về chúng. Trace chứa prompt, câu trả lời và
salt: hãy lưu trữ cẩn thận như chính cuộc hội thoại.
