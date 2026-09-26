import express from "express";
import cors from "cors";
import { silenceLibsignal } from "./lib/logging/silenceLibsignal.js";
import routes from "./routes.js";
import {
  resetAllSessionStatus,
  autoRestartSessions,
  initTelegramBot,
} from "./manager.js";

// Antes de tudo: o libsignal (dentro do Baileys) loga o objeto de sessão inteiro
// no console global, incluindo privKey/rootKey, e paga util.inspect por evento.
// Ver o comentário do módulo para o porquê.
silenceLibsignal();

const app = express();

app.use(cors());
// Limite acima do default (100 kb) porque o disparo manual de promoção envia a
// imagem em base64 no corpo do POST (/sessions/:id/send).
app.use(express.json({ limit: "12mb" }));
app.use(routes);

const PORT = 3001;

app.listen(PORT, async () => {
  console.log(`Bot Manager rodando na porta ${PORT}`);
  initTelegramBot();
  await resetAllSessionStatus();
  await autoRestartSessions();
});
