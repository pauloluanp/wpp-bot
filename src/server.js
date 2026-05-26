import express from "express";
import cors from "cors";
import routes from "./routes.js";
import {
  resetAllSessionStatus,
  autoRestartSessions,
  initTelegramBot,
} from "./manager.js";

const app = express();

app.use(cors());
app.use(express.json());
app.use(routes);

const PORT = 3001;

app.listen(PORT, async () => {
  console.log(`Bot Manager rodando na porta ${PORT}`);
  initTelegramBot();
  await resetAllSessionStatus();
  await autoRestartSessions();
});
