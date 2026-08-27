async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function card(msg) {
  const el = document.createElement("section");
  el.className = `card ${msg.kind} ${msg.status}`;

  const images = (msg.images || [])
    .map((img) => `<img src="/api/image?path=${encodeURIComponent(img.path)}" />`)
    .join("");

  const options = (msg.options || [])
    .map((opt) => `<button class="opt" data-opt="${encodeURIComponent(opt)}">${opt}</button>`)
    .join("");

  const details = (msg.details || []).map((d) => `<li>${d}</li>`).join("");

  el.innerHTML = `
    <div class="card-head">
      <span class="kind-badge">${msg.kind}</span>
      <strong>${msg.title}</strong>
      ${msg.project ? `<span class="project">${msg.project}</span>` : ""}
    </div>
    ${msg.context ? `<p class="context">${msg.context}</p>` : ""}
    ${details ? `<ul>${details}</ul>` : ""}
    ${images ? `<div class="images">${images}</div>` : ""}
    ${
      msg.status === "answered"
        ? `<div class="answered">Replied: ${msg.reply.optionChosen || msg.reply.text}</div>`
        : `<div class="reply-row">
            ${options}
            <input class="reply-text" placeholder="Comment / approve / reject…" />
            <button class="send-reply">Reply</button>
          </div>`
    }
  `;

  if (msg.status !== "answered") {
    el.querySelectorAll(".opt").forEach((btn) =>
      btn.addEventListener("click", () => sendReply(msg.id, { optionChosen: decodeURIComponent(btn.dataset.opt) }))
    );
    el.querySelector(".send-reply").addEventListener("click", () => {
      const text = el.querySelector(".reply-text").value;
      if (text.trim()) sendReply(msg.id, { text });
    });
  }

  return el;
}

async function sendReply(id, body) {
  await fetchJSON(`/api/reviews/${id}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  refresh();
}

async function refresh() {
  const msgs = await fetchJSON("/api/reviews");
  const container = document.getElementById("cards");
  container.innerHTML = "";
  msgs
    .filter((m) => m.direction === "agent")
    .slice()
    .reverse()
    .forEach((m) => container.appendChild(card(m)));
}

document.getElementById("compose").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("composeText");
  const text = input.value.trim();
  if (!text) return;
  await fetchJSON("/api/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  input.value = "";
});

new EventSource("/api/events").addEventListener("message", refresh);
refresh();
